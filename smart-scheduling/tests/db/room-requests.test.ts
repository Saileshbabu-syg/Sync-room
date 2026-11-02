import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  meeting,
  recurrence_frequency_master,
  room,
  room_request_emails,
  room_request_holders,
  room_requests,
} from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  type BookingInput,
} from "@/lib/services/booking.service";
import { getMailSender } from "@/lib/services/email.service";
import { processPendingRoomRequestEmails } from "@/lib/services/room-request-email.service";
import {
  approveRoomRequest,
  cancelRoomRequest,
  createRoomRequest,
  describeConflict,
  expireRoomRequests,
  fulfilAwaitingRequests,
  getRoomRequestFor,
  rejectRoomRequest,
  releaseAndBook,
  RoomRequestError,
} from "@/lib/services/room-request.service";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

// E-mail is sent in the background after a call returns.
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

before(async () => {
  f = await seedFixtures();
  mail = captureMail(); // nothing leaves the process
});

after(() => mail?.restore());

beforeEach(async () => {
  await settle();
  mail.setFailures(0);
  mail.sent.length = 0;
  await db.execute(sql`
    TRUNCATE meeting_audit_logs, reminder_logs, notifications,
      reschedule_requests, room_request_emails, room_request_holders,
      room_requests, meeting_attendees, meeting, recurring_meetings
    RESTART IDENTITY CASCADE
  `);
  await db
    .update(room)
    .set({ availabilityStatusId: 1 })
    .where(eq(room.room_id, f.rooms.alpha.room_id));
});

const DAY = () => dateFromToday(7);

// Wall-clock moment (app timezone) on the test day, for the `now` test hook.
const at = (time: string) => new Date(`${DAY()}T${time}:00+05:30`);

// Bob's team meeting in Alpha, 10:00-11:00: the booking people ask for.
async function bobHoldsAlpha(overrides: Partial<BookingInput> = {}) {
  const { meetings } = await createBooking({
    title: "Bob sync",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [DAY()],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 2,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [f.users.dave.employeeId],
    notify: false,
    ...overrides,
  });

  return meetings[0];
}

type RequestInput = Parameters<typeof createRoomRequest>[0];

// Carol asks for Alpha at the same time (equal priority, so she cannot just
// take it).
async function carolAsks(overrides: Partial<RequestInput> = {}) {
  const { request } = await createRoomRequest({
    requesterEmployeeId: f.users.carol.employeeId,
    requesterRole: "Employee",
    roomId: f.rooms.alpha.room_id,
    meetingDate: DAY(),
    startTime: "10:00",
    endTime: "11:00",
    title: "Carol review",
    message: "Important client call, could you release the room?",
    participantCount: 2,
    meetingTypeId: f.types.team,
    ...overrides,
  });

  return request;
}

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof RoomRequestError,
      `expected RoomRequestError, got ${error}`
    );
    return error;
  }

  assert.fail("expected the request to be refused");
}

const requestRow = async (id: number) =>
  (
    await db
      .select()
      .from(room_requests)
      .where(eq(room_requests.room_request_id, id))
  )[0];

const meetingRow = async (id: number) =>
  (await db.select().from(meeting).where(eq(meeting.meeting_id, id)))[0];

// Confirmed meetings in Alpha overlapping 10:00-11:00 on the test day: this
// must never be more than one.
async function confirmedInAlpha() {
  return db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, f.rooms.alpha.room_id),
        eq(meeting.meeting_date, DAY()),
        ne(meeting.meetingStatusId, MEETING_STATUS.CANCELLED),
        sql`${meeting.start_time} < '11:00'::time AND ${meeting.end_time} > '10:00'::time`
      )
    );
}

const cancelMeeting = (id: number) =>
  db
    .update(meeting)
    .set({ meetingStatusId: MEETING_STATUS.CANCELLED })
    .where(eq(meeting.meeting_id, id));

const emailKinds = async (requestId: number) =>
  (
    await db
      .select({ kind: room_request_emails.kind, status: room_request_emails.status })
      .from(room_request_emails)
      .where(eq(room_request_emails.room_request_id, requestId))
  )
    .map((e) => `${e.kind}:${e.status}`)
    .sort();

describe("conflict details", () => {
  it("shows the organizer and slot, and the title only to people who may see it", async () => {
    await bobHoldsAlpha();

    const args = [f.rooms.alpha.room_id, DAY(), "10:00", "11:00"] as const;

    const stranger = await describeConflict(...args, {
      employeeId: f.users.carol.employeeId,
      role: "Employee",
    });
    assert.ok(stranger.requestable);
    assert.equal(stranger.bookings.length, 1);
    assert.equal(stranger.bookings[0].organizerName, "Bob Employee");
    assert.equal(stranger.bookings[0].roomName, "Alpha");
    assert.equal(stranger.bookings[0].title, null, "private to strangers");

    const attendee = await describeConflict(...args, {
      employeeId: f.users.dave.employeeId,
      role: "Employee",
    });
    assert.ok(attendee.requestable);
    assert.equal(attendee.bookings[0].title, "Bob sync");

    const admin = await describeConflict(...args, {
      employeeId: f.users.admin.employeeId,
      role: "Admin",
    });
    assert.ok(admin.requestable);
    assert.equal(admin.bookings[0].title, "Bob sync");
  });

  it("says when it cannot be requested", async () => {
    const args = [f.rooms.alpha.room_id, DAY(), "10:00", "11:00"] as const;
    const carol = { employeeId: f.users.carol.employeeId, role: "Employee" };

    assert.equal((await describeConflict(...args, carol)).requestable, false, "free room");

    await bobHoldsAlpha();

    const own = await describeConflict(...args, {
      employeeId: f.users.bob.employeeId,
      role: "Employee",
    });
    assert.equal(own.requestable, false);
    assert.equal(!own.requestable && own.code, "OWN_BOOKING", "your own booking");

    // After asking once, the same slot says so instead of offering it again.
    await carolAsks();

    const again = await describeConflict(...args, carol);
    assert.equal(again.requestable, false);
    assert.equal(!again.requestable && again.code, "ALREADY_REQUESTED");
  });
});

describe("creating a room request", () => {
  it("stores the request with its relationships and e-mails the real organizer", async () => {
    const held = await bobHoldsAlpha();

    const request = await carolAsks({ message: "  Client visit at 10, please.  " });
    await settle();

    assert.equal(request.status, "PENDING");
    assert.equal(request.holder_meeting_id, held.meeting_id);
    assert.equal(request.holder_organizer_employee_id, f.users.bob.employeeId);
    assert.equal(request.requester_employee_id, f.users.carol.employeeId);

    const holderRows = await db.select().from(room_request_holders);
    assert.equal(holderRows.length, 1);
    assert.equal(holderRows[0].status, "PENDING");
    assert.equal(request.room_id, f.rooms.alpha.room_id);
    assert.equal(request.message, "Client visit at 10, please.", "trimmed, otherwise as written");

    assert.equal(mail.sent.length, 1);
    const [m] = mail.sent;
    assert.equal(m.to, f.users.bob.email, "resolved from the database");
    assert.equal(m.from, getMailSender(), "the centralized sender");
    assert.match(m.subject, new RegExp(`^Room Request: Alpha — ${DAY()}`));
    assert.match(m.text, /Carol Employee \(carol\.emp@example\.test\)/);
    assert.match(m.text, /Client visit at 10, please\./);
    assert.match(m.text, new RegExp(`Request #${request.room_request_id}`));
    assert.match(m.text, /Bob sync/, "the organizer's own meeting title");
    assert.match(m.text, /Approve Request/);
    assert.match(m.text, /Reject Request/);
    assert.match(m.text, /Asia\/Kolkata/);

    assert.deepEqual(await emailKinds(request.room_request_id), ["SUBMITTED:SENT"]);

    // Asking does not touch the booked meeting.
    assert.equal((await meetingRow(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("rejects an empty or over-long message", async () => {
    await bobHoldsAlpha();

    for (const message of ["", "   \n ", "x".repeat(1001)]) {
      assert.equal((await refused(carolAsks({ message }))).status, 400);
    }

    assert.equal((await db.select().from(room_requests)).length, 0);
  });

  it("handles repeated and simultaneous submits without duplicates", async () => {
    await bobHoldsAlpha();

    const key = "retry-key-0001";
    const first = await createRoomRequest({
      requesterEmployeeId: f.users.carol.employeeId,
      requesterRole: "Employee",
      roomId: f.rooms.alpha.room_id,
      meetingDate: DAY(),
      startTime: "10:00",
      endTime: "11:00",
      title: "Carol review",
      message: "Please",
      participantCount: 2,
      meetingTypeId: f.types.team,
      clientRequestId: key,
    });
    const retry = await createRoomRequest({ ...{
      requesterEmployeeId: f.users.carol.employeeId,
      requesterRole: "Employee",
      roomId: f.rooms.alpha.room_id,
      meetingDate: DAY(),
      startTime: "10:00",
      endTime: "11:00",
      title: "Carol review",
      message: "Please",
      participantCount: 2,
      meetingTypeId: f.types.team,
    }, clientRequestId: key });

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.request.room_request_id, first.request.room_request_id);

    // A different submit without the key: still one open request each.
    assert.equal((await refused(carolAsks())).status, 409);

    await settle();
    assert.equal((await db.select().from(room_requests)).length, 1);
    assert.equal(mail.sent.length, 1, "the organizer is mailed once");
  });

  it("two identical submits racing create one request", async () => {
    await bobHoldsAlpha();

    const submit = () =>
      carolAsks({ clientRequestId: "race-key-0001" });

    const results = await Promise.allSettled([submit(), submit()]);

    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal((await db.select().from(room_requests)).length, 1);
  });

  it("refuses a free room, your own room, and a role that may not book the type", async () => {
    assert.equal((await refused(carolAsks())).status, 409, "free: book it directly");

    await bobHoldsAlpha();

    assert.equal(
      (
        await refused(
          carolAsks({
            requesterEmployeeId: f.users.bob.employeeId,
            participantCount: 1,
          })
        )
      ).status,
      409,
      "own booking"
    );

    assert.equal(
      (await refused(carolAsks({ meetingTypeId: f.types.client }))).status,
      403
    );
  });
});

describe("who can see and answer a request", () => {
  it("only the requester and the booked meeting's organizer can read it", async () => {
    await bobHoldsAlpha();
    const request = await carolAsks();
    const id = request.room_request_id;

    assert.ok(await getRoomRequestFor(id, f.users.carol.employeeId));
    assert.ok(await getRoomRequestFor(id, f.users.bob.employeeId));
    assert.equal(await getRoomRequestFor(id, f.users.manager.employeeId), null);
    assert.equal(await getRoomRequestFor(id, f.users.admin.employeeId), null);
  });

  it("nobody but the organizer can approve, reject or release; only the requester can cancel", async () => {
    await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    for (const stranger of [f.users.carol, f.users.manager, f.users.admin]) {
      assert.equal((await refused(approveRoomRequest(id, stranger.employeeId))).status, 404);
      assert.equal((await refused(rejectRoomRequest(id, stranger.employeeId))).status, 404);
      assert.equal((await refused(releaseAndBook(id, stranger.employeeId))).status, 404);
    }

    assert.equal((await refused(cancelRoomRequest(id, f.users.bob.employeeId))).status, 404);
    assert.equal((await requestRow(id)).status, "PENDING");
  });
});

describe("approval never creates an overlapping booking", () => {
  it("with the original booking still in place it records the approval and books nothing", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;
    await settle();
    mail.sent.length = 0;

    const result = await approveRoomRequest(id, f.users.bob.employeeId);
    await settle();

    assert.equal(result.outcome, "awaiting_slot");

    const row = await requestRow(id);
    assert.equal(row.status, "AWAITING_SLOT");
    assert.equal(row.resulting_meeting_id, null);
    assert.ok(row.organizer_approved_at);

    // Nothing booked, nothing cancelled, never two confirmed bookings.
    assert.equal((await meetingRow(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal((await confirmedInAlpha()).length, 1);

    const byRecipient = Object.fromEntries(mail.sent.map((m) => [m.to, m]));
    assert.match(byRecipient[f.users.bob.email].subject, /waiting for your booking/);
    assert.match(byRecipient[f.users.carol.email].subject, /not booked yet/);
    assert.ok(
      mail.sent.every((m) => !/approved and booked/i.test(m.subject)),
      "no e-mail claims the room is booked"
    );
  });

  it("is completed automatically once the organizer cancels their own meeting", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;
    await approveRoomRequest(id, f.users.bob.employeeId);

    assert.equal(await fulfilAwaitingRequests(), 0, "still held: nothing happens");
    assert.equal((await requestRow(id)).status, "AWAITING_SLOT");

    await cancelMeeting(held.meeting_id);
    assert.equal(await fulfilAwaitingRequests(), 1);
    await settle();

    const row = await requestRow(id);
    assert.equal(row.status, "APPROVED");
    assert.ok(row.resulting_meeting_id);

    const booked = await meetingRow(row.resulting_meeting_id!);
    assert.equal(booked.organizerEmployeeId, f.users.carol.employeeId);
    assert.equal(booked.room_id, f.rooms.alpha.room_id);
    assert.equal(booked.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal((await confirmedInAlpha()).length, 1);

    assert.ok(
      mail.sent.some((m) => m.to === f.users.carol.email && /approved and booked/i.test(m.subject))
    );
    assert.equal(await fulfilAwaitingRequests(), 0, "only once");
  });

  it("books straight away if the organizer's meeting was already cancelled", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    await cancelMeeting(held.meeting_id);

    const result = await approveRoomRequest(id, f.users.bob.employeeId);

    assert.equal(result.outcome, "booked");
    assert.equal((await requestRow(id)).status, "APPROVED");
    assert.equal((await confirmedInAlpha()).length, 1);
  });

  it("only cancels the organizer's booking when they explicitly release it", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    const result = await approveRoomRequest(id, f.users.bob.employeeId, {
      releaseBooking: true,
    });
    await settle();

    assert.equal(result.outcome, "booked");
    assert.equal((await meetingRow(held.meeting_id)).meetingStatusId, MEETING_STATUS.CANCELLED);

    const row = await requestRow(id);
    assert.equal(row.status, "APPROVED");
    assert.equal(row.decided_by_employee_id, f.users.bob.employeeId);
    assert.ok(row.responded_at);
    assert.equal((await confirmedInAlpha()).length, 1);

    const subjects = mail.sent.map((m) => m.subject);
    assert.ok(subjects.some((s) => /approved and booked/i.test(s)));
    assert.ok(subjects.some((s) => /Meeting Cancelled/.test(s)), "the organizer gets the cancellation");
  });

  it("an approved request waiting for the room can be completed with an explicit release", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;
    await approveRoomRequest(id, f.users.bob.employeeId);

    await releaseAndBook(id, f.users.bob.employeeId);

    assert.equal((await requestRow(id)).status, "APPROVED");
    assert.equal((await meetingRow(held.meeting_id)).meetingStatusId, MEETING_STATUS.CANCELLED);
    assert.equal((await confirmedInAlpha()).length, 1);
  });

  it("approving one request rejects the others waiting on the same meeting", async () => {
    await bobHoldsAlpha();
    const carols = (await carolAsks()).room_request_id;
    const managers = (
      await createRoomRequest({
        requesterEmployeeId: f.users.manager.employeeId,
        requesterRole: "Manager",
        roomId: f.rooms.alpha.room_id,
        meetingDate: DAY(),
        startTime: "10:00",
        endTime: "11:00",
        title: "Manager sync",
        message: "Board prep",
        participantCount: 1,
        meetingTypeId: f.types.team,
      })
    ).request.room_request_id;

    await approveRoomRequest(carols, f.users.bob.employeeId, { releaseBooking: true });

    assert.equal((await requestRow(carols)).status, "APPROVED");
    const other = await requestRow(managers);
    assert.equal(other.status, "REJECTED");
    assert.match(other.rejection_reason ?? "", /another request/);
    assert.equal((await confirmedInAlpha()).length, 1);
  });

  it("does not mark the request approved when the booking cannot be made", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    await db
      .update(room)
      .set({ availabilityStatusId: 2 })
      .where(eq(room.room_id, f.rooms.alpha.room_id));

    await assert.rejects(
      approveRoomRequest(id, f.users.bob.employeeId, { releaseBooking: true }),
      BookingError
    );

    const row = await requestRow(id);
    assert.equal(row.status, "PENDING", "not APPROVED");
    assert.equal(row.resulting_meeting_id, null);
    assert.equal((await meetingRow(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED, "rolled back");
  });

  it("an approved request that can no longer be booked ends as FAILED, with e-mail", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;
    await approveRoomRequest(id, f.users.bob.employeeId);

    await cancelMeeting(held.meeting_id);
    await db
      .update(room)
      .set({ availabilityStatusId: 2 })
      .where(eq(room.room_id, f.rooms.alpha.room_id));

    assert.equal(await fulfilAwaitingRequests(), 0);
    await settle();

    assert.equal((await requestRow(id)).status, "FAILED");
    assert.equal((await confirmedInAlpha()).length, 0);
    assert.ok(mail.sent.some((m) => m.to === f.users.carol.email && /could not be booked/.test(m.subject)));
  });

  it("two simultaneous approvals book exactly once", async () => {
    await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    const results = await Promise.allSettled([
      approveRoomRequest(id, f.users.bob.employeeId, { releaseBooking: true }),
      approveRoomRequest(id, f.users.bob.employeeId, { releaseBooking: true }),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (await db.select().from(meeting).where(eq(meeting.organizerEmployeeId, f.users.carol.employeeId))).length,
      1,
      "one booking for the requester"
    );
    assert.equal((await confirmedInAlpha()).length, 1);
  });

  it("a request cannot be approved after it was rejected or cancelled", async () => {
    await bobHoldsAlpha();

    const rejected = (await carolAsks()).room_request_id;
    await rejectRoomRequest(rejected, f.users.bob.employeeId);
    assert.equal((await refused(approveRoomRequest(rejected, f.users.bob.employeeId))).status, 409);

    await db.execute(sql`UPDATE room_requests SET status = 'CANCELLED'`);
    assert.equal((await refused(approveRoomRequest(rejected, f.users.bob.employeeId))).status, 409);
    assert.equal((await confirmedInAlpha()).length, 1);
  });
});

describe("rejecting and cancelling", () => {
  it("rejection records who, when and why, and tells the requester", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;
    await settle();
    mail.sent.length = 0;

    await rejectRoomRequest(id, f.users.bob.employeeId, "  Client visit on our side  ");
    await settle();

    const row = await requestRow(id);
    assert.equal(row.status, "REJECTED");
    assert.equal(row.rejection_reason, "Client visit on our side");
    assert.equal(row.decided_by_employee_id, f.users.bob.employeeId);
    assert.ok(row.responded_at);
    assert.equal((await meetingRow(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);

    const [m] = mail.sent;
    assert.equal(m.to, f.users.carol.email);
    assert.equal(m.from, getMailSender());
    assert.match(m.subject, /rejected/);
    assert.match(m.text, /Client visit on our side/);
  });

  it("no repeated or contradictory decisions", async () => {
    await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    await rejectRoomRequest(id, f.users.bob.employeeId);

    assert.equal((await refused(rejectRoomRequest(id, f.users.bob.employeeId))).status, 409);
    assert.equal((await refused(approveRoomRequest(id, f.users.bob.employeeId))).status, 409);

    // Approved in principle cannot then be rejected.
    await db.execute(sql`TRUNCATE room_requests, room_request_emails RESTART IDENTITY CASCADE`);
    const second = (await carolAsks()).room_request_id;
    await approveRoomRequest(second, f.users.bob.employeeId);
    assert.equal((await refused(rejectRoomRequest(second, f.users.bob.employeeId))).status, 409);
    assert.equal((await refused(approveRoomRequest(second, f.users.bob.employeeId))).status, 409);
  });

  it("the requester can cancel an open request, once, and the organizer is told", async () => {
    await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;
    await settle();
    mail.sent.length = 0;

    await cancelRoomRequest(id, f.users.carol.employeeId);
    await settle();

    assert.equal((await requestRow(id)).status, "CANCELLED");
    assert.equal((await refused(cancelRoomRequest(id, f.users.carol.employeeId))).status, 409);
    assert.equal(mail.sent[0].to, f.users.bob.email);
  });
});

describe("unanswered requests", () => {
  it("expire when the requested time starts, whether pending or waiting for the room", async () => {
    await bobHoldsAlpha();
    const pending = (await carolAsks()).room_request_id;
    await settle();
    mail.sent.length = 0;

    assert.equal(await expireRoomRequests(at("09:59")), 0, "still time");
    assert.equal(await expireRoomRequests(at("10:01")), 1);
    await settle();

    assert.equal((await requestRow(pending)).status, "EXPIRED");
    assert.equal(mail.sent[0].to, f.users.carol.email);
    assert.match(mail.sent[0].subject, /expired/);
    assert.equal(await expireRoomRequests(at("10:02")), 0, "only once");

    // The same for an approved request that never got its room.
    const waiting = (await carolAsks()).room_request_id;
    await approveRoomRequest(waiting, f.users.bob.employeeId);
    assert.equal(await expireRoomRequests(at("10:01")), 1);
    assert.equal((await requestRow(waiting)).status, "EXPIRED");
  });

  it("cannot be approved after the time has started", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    const error = await refused(
      approveRoomRequest(id, f.users.bob.employeeId, { now: at("10:05") })
    );

    assert.equal(error.status, 409);
    assert.equal((await requestRow(id)).status, "EXPIRED");
    assert.equal((await meetingRow(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });
});

describe("recurring meetings", () => {
  it("a request points at the exact occurrence, and releasing it leaves the rest of the series", async () => {
    const [frequency] = await db.select().from(recurrence_frequency_master).limit(1);
    const secondDay = dateFromToday(14);

    const { meetings } = await createBooking({
      title: "Weekly sync",
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [DAY(), secondDay],
      startTime: "10:00",
      endTime: "11:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 2,
      meetingTypeId: f.types.team,
      recurrence: { frequencyId: frequency.frequency_id, occurrenceCount: 2 },
      notify: false,
    });

    const [first, second] = meetings;

    const request = await carolAsks({ meetingDate: secondDay });

    assert.equal(request.holder_meeting_id, second.meeting_id, "the second occurrence, not the series");
    assert.equal(request.meeting_date, secondDay);

    await approveRoomRequest(request.room_request_id, f.users.bob.employeeId, {
      releaseBooking: true,
    });

    assert.equal((await meetingRow(second.meeting_id)).meetingStatusId, MEETING_STATUS.CANCELLED);
    assert.equal(
      (await meetingRow(first.meeting_id)).meetingStatusId,
      MEETING_STATUS.SCHEDULED,
      "the other occurrence is untouched"
    );
    assert.equal((await requestRow(request.room_request_id)).status, "APPROVED");
  });

  it("an occurrence cancelled before the answer lets approval book straight away", async () => {
    const held = await bobHoldsAlpha();
    const id = (await carolAsks()).room_request_id;

    await cancelMeeting(held.meeting_id);

    assert.equal((await approveRoomRequest(id, f.users.bob.employeeId)).outcome, "booked");
  });
});

describe("overlapping bookings", () => {
  it("two people booking the same free slot at once: exactly one wins", async () => {
    const book = (userKey: "bob" | "carol") =>
      createBooking({
        title: `${userKey} meeting`,
        roomId: f.rooms.alpha.room_id,
        occurrenceDates: [DAY()],
        startTime: "10:00",
        endTime: "11:00",
        organizerEmployeeId: f.users[userKey].employeeId,
        organizerRole: "Employee",
        participantCount: 1,
        meetingTypeId: f.types.team,
        notify: false,
      });

    const results = await Promise.allSettled([book("bob"), book("carol")]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await confirmedInAlpha()).length, 1);
  });
});

describe("e-mail delivery", () => {
  it("a failed send keeps the request and is retried without duplicates", async () => {
    await bobHoldsAlpha();

    mail.setFailures(1);
    const request = await carolAsks();
    await settle();

    // Persisted, still pending, not mailed yet.
    assert.equal((await requestRow(request.room_request_id)).status, "PENDING");
    assert.equal(mail.sent.length, 0);

    const [failed] = await db
      .select()
      .from(room_request_emails)
      .where(eq(room_request_emails.room_request_id, request.room_request_id));

    assert.equal(failed.status, "PENDING");
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error ?? "", /delivery failed/);
    assert.ok(!/smtp|password|@/i.test(failed.last_error ?? ""), "safe to show");

    // The retry sends it exactly once and creates nothing new.
    const summary = await processPendingRoomRequestEmails(0);
    assert.equal(summary.SENT, 1);
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, f.users.bob.email);

    assert.equal((await processPendingRoomRequestEmails(0)).SENT, 0, "not sent twice");
    assert.equal((await db.select().from(room_requests)).length, 1);
    assert.equal((await db.select().from(meeting)).length, 1, "no extra booking");
  });
});

// ---------------------------------------------------------------------------
// One request, several booked meetings in the way (maybe several organizers).
// ---------------------------------------------------------------------------

// Bob 10:00-10:30 and the manager 10:30-11:00, both in Alpha.
async function twoOrganizersHoldAlpha() {
  const bobs = await bobHoldsAlpha({ endTime: "10:30" });
  const managers = await bobHoldsAlpha({
    title: "Manager sync",
    startTime: "10:30",
    endTime: "11:00",
    organizerEmployeeId: f.users.manager.employeeId,
    organizerRole: "Manager",
    participantCount: 1,
    participantEmployeeIds: [],
  });

  return { bobs, managers };
}

const holderStatuses = async (requestId: number) =>
  Object.fromEntries(
    (
      await db
        .select()
        .from(room_request_holders)
        .where(eq(room_request_holders.room_request_id, requestId))
    ).map((h) => [h.holder_meeting_id, h.status])
  );

describe("a request that spans several bookings", () => {
  it("can be made, records every booking, and e-mails each organizer about their own", async () => {
    const { bobs, managers } = await twoOrganizersHoldAlpha();

    const request = await carolAsks();
    await settle();

    assert.deepEqual(await holderStatuses(request.room_request_id), {
      [bobs.meeting_id]: "PENDING",
      [managers.meeting_id]: "PENDING",
    });

    const byRecipient = Object.fromEntries(mail.sent.map((m) => [m.to, m]));
    assert.equal(mail.sent.length, 2, "one e-mail per organizer");
    assert.match(byRecipient[f.users.bob.email].text, /Bob sync/);
    assert.ok(!/Manager sync/.test(byRecipient[f.users.bob.email].text), "only their own meeting");
    assert.match(byRecipient[f.users.manager.email].text, /Manager sync/);
    assert.match(byRecipient[f.users.bob.email].text, /1 other organizer/);
  });

  it("one organizer with two meetings in the way gets one e-mail", async () => {
    await bobHoldsAlpha({ endTime: "10:30" });
    await bobHoldsAlpha({ startTime: "10:30", endTime: "11:00", title: "Bob second" });

    const request = await carolAsks();
    await settle();

    assert.equal((await db.select().from(room_request_holders)).length, 2);
    assert.equal(mail.sent.length, 1);

    // One approval covers both of their meetings.
    const result = await approveRoomRequest(request.room_request_id, f.users.bob.employeeId, {
      releaseBooking: true,
    });

    assert.equal(result.outcome, "booked");
    assert.equal((await confirmedInAlpha()).length, 1);
  });

  it("is refused when one of the bookings is yours, or too many overlap", async () => {
    await bobHoldsAlpha({ endTime: "10:30" });
    await bobHoldsAlpha({
      startTime: "10:30",
      endTime: "11:00",
      organizerEmployeeId: f.users.carol.employeeId,
      participantCount: 1,
      participantEmployeeIds: [],
    });

    assert.equal((await refused(carolAsks())).status, 409, "one is hers");

    await db.execute(sql`TRUNCATE meeting_attendees, meeting RESTART IDENTITY CASCADE`);

    for (let i = 0; i < 6; i++) {
      await bobHoldsAlpha({
        title: `Short ${i}`,
        startTime: `10:${String(i * 10).padStart(2, "0")}`,
        endTime: `10:${String(i * 10 + 10).padStart(2, "0")}`.replace("10:60", "11:00"),
      });
    }

    assert.equal((await refused(carolAsks())).status, 409, "more than 5 bookings");
  });

  it("needs every organizer: one approval alone books nothing and cancels nothing", async () => {
    const { bobs, managers } = await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;

    const result = await approveRoomRequest(id, f.users.bob.employeeId, { releaseBooking: true });

    assert.equal(result.outcome, "waiting_others");

    assert.equal((await requestRow(id)).status, "PENDING");
    assert.equal((await holderStatuses(id))[bobs.meeting_id], "APPROVED");
    assert.equal((await holderStatuses(id))[managers.meeting_id], "PENDING");
    assert.equal((await db.select().from(meeting).where(eq(meeting.organizerEmployeeId, f.users.carol.employeeId))).length, 0, "nothing was booked for the requester");

    // Bob chose to release his own meeting, so that one is gone; the manager's is not touched.
    assert.equal((await meetingRow(bobs.meeting_id)).meetingStatusId, MEETING_STATUS.CANCELLED);
    assert.equal((await meetingRow(managers.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("books only once all agreed and every booking in the way is gone", async () => {
    const { bobs, managers } = await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;

    await approveRoomRequest(id, f.users.bob.employeeId); // agrees, keeps his meeting

    // The manager agrees and releases his, but Bob's meeting still holds the room.
    const second = await approveRoomRequest(id, f.users.manager.employeeId, {
      releaseBooking: true,
    });
    await settle();

    assert.equal(second.outcome, "awaiting_slot");
    assert.equal((await requestRow(id)).status, "AWAITING_SLOT");
    assert.equal((await meetingRow(managers.meeting_id)).meetingStatusId, MEETING_STATUS.CANCELLED);
    assert.equal((await meetingRow(bobs.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);

    // Only Bob (still holding) is asked to act; the requester hears it is not booked yet.
    const awaiting = mail.sent.filter((m) => /waiting for your booking/.test(m.subject));
    assert.deepEqual(awaiting.map((m) => m.to), [f.users.bob.email]);
    assert.ok(mail.sent.some((m) => m.to === f.users.carol.email && /not booked yet/.test(m.subject)));

    // Bob releases: his is the last thing in the way, so it books.
    const done = await releaseAndBook(id, f.users.bob.employeeId);

    assert.equal(done.outcome, "booked");
    assert.equal((await requestRow(id)).status, "APPROVED");
    assert.equal((await confirmedInAlpha()).length, 1);
    assert.equal((await confirmedInAlpha())[0].organizerEmployeeId, f.users.carol.employeeId);
  });

  it("is completed automatically when the last organizer simply cancels their meeting", async () => {
    const { bobs, managers } = await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;

    await approveRoomRequest(id, f.users.bob.employeeId);
    await approveRoomRequest(id, f.users.manager.employeeId);
    assert.equal((await requestRow(id)).status, "AWAITING_SLOT");

    await cancelMeeting(managers.meeting_id);
    assert.equal(await fulfilAwaitingRequests(), 0, "Bob's meeting still holds the room");

    await cancelMeeting(bobs.meeting_id);
    assert.equal(await fulfilAwaitingRequests(), 1);

    assert.equal((await requestRow(id)).status, "APPROVED");
    assert.equal((await confirmedInAlpha()).length, 1);
  });

  it("any one organizer rejecting rejects the whole request", async () => {
    const { bobs, managers } = await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;
    await settle();
    mail.sent.length = 0;

    await rejectRoomRequest(id, f.users.manager.employeeId, "Board prep");
    await settle();

    assert.equal((await requestRow(id)).status, "REJECTED");
    assert.equal((await holderStatuses(id))[managers.meeting_id], "REJECTED");
    assert.equal((await meetingRow(bobs.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, f.users.carol.email);
    assert.match(mail.sent[0].text, /Board prep/);

    // The other organizer can no longer approve it.
    assert.equal((await refused(approveRoomRequest(id, f.users.bob.employeeId))).status, 409);
  });

  it("an organizer cannot answer twice or change their mind", async () => {
    await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;

    await approveRoomRequest(id, f.users.bob.employeeId);

    assert.equal((await refused(approveRoomRequest(id, f.users.bob.employeeId))).status, 409);
    assert.equal((await refused(rejectRoomRequest(id, f.users.bob.employeeId))).status, 409);
  });

  it("can only be read and answered by the people involved", async () => {
    await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;

    const forManager = await getRoomRequestFor(id, f.users.manager.employeeId);
    assert.ok(forManager);
    const own = forManager.holders.filter((h) => h.own);
    assert.equal(own.length, 1);
    assert.equal(own[0].title, "Manager sync");
    assert.ok(
      forManager.holders.filter((h) => !h.own).every((h) => h.title === null),
      "other organizers' meetings stay private"
    );

    assert.equal(await getRoomRequestFor(id, f.users.admin.employeeId), null);
    assert.equal((await refused(approveRoomRequest(id, f.users.admin.employeeId))).status, 404);
  });

  it("two organizers answering at the same moment book exactly once", async () => {
    await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;

    await Promise.all([
      approveRoomRequest(id, f.users.bob.employeeId, { releaseBooking: true }),
      approveRoomRequest(id, f.users.manager.employeeId, { releaseBooking: true }),
    ]);

    assert.equal((await requestRow(id)).status, "APPROVED");
    assert.equal(
      (await db.select().from(meeting).where(eq(meeting.organizerEmployeeId, f.users.carol.employeeId))).length,
      1
    );
    assert.equal((await confirmedInAlpha()).length, 1);
  });

  it("when the requester cancels, every organizer is told", async () => {
    await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;
    await settle();
    mail.sent.length = 0;

    await cancelRoomRequest(id, f.users.carol.employeeId);
    await settle();

    assert.equal((await requestRow(id)).status, "CANCELLED");
    assert.deepEqual(
      mail.sent.map((m) => m.to).sort(),
      [f.users.bob.email, f.users.manager.email].sort()
    );
  });

  it("an approved booking attempt that is refused marks the request FAILED, not approved", async () => {
    const { bobs, managers } = await twoOrganizersHoldAlpha();
    const id = (await carolAsks()).room_request_id;

    await approveRoomRequest(id, f.users.bob.employeeId);
    await approveRoomRequest(id, f.users.manager.employeeId);

    await cancelMeeting(bobs.meeting_id);
    await cancelMeeting(managers.meeting_id);
    await db
      .update(room)
      .set({ availabilityStatusId: 2 })
      .where(eq(room.room_id, f.rooms.alpha.room_id));

    await fulfilAwaitingRequests();

    assert.equal((await requestRow(id)).status, "FAILED");
    assert.equal((await confirmedInAlpha()).length, 0);
  });
});
