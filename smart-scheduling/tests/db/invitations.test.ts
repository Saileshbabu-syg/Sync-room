import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, meeting_attendees, notifications } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import {
  getInvitationInfo,
  respondToInvitation,
} from "@/lib/services/invitation.service";
import { deliverNotification } from "@/lib/services/notification.service";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

before(async () => {
  f = await seedFixtures();
  mail = captureMail();
});

after(() => mail?.restore());

beforeEach(async () => {
  mail.sent.length = 0;
  await db.execute(sql`
    TRUNCATE booking_priority_history, meeting_audit_logs, reminder_logs,
      notifications, reschedule_requests, meeting_attendees, meeting,
      recurring_meetings
    RESTART IDENTITY CASCADE
  `);
});

// Bob organizes and invites Carol and Dave.
function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Planning",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [dateFromToday(7)],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Manager",
    participantCount: 3,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [f.users.carol.employeeId, f.users.dave.employeeId],
    notify: false,
    ...overrides,
  };
}

const responseOf = async (meetingId: number, employeeId: number) =>
  (
    await db
      .select()
      .from(meeting_attendees)
      .where(
        and(
          eq(meeting_attendees.meeting_id, meetingId),
          eq(meeting_attendees.employee_id, employeeId)
        )
      )
  )[0];

describe("booking with participants", () => {
  it("starts the organizer as Accepted and everyone else without a response", async () => {
    const { meetings: [m] } = await createBooking(input());

    assert.equal((await responseOf(m.meeting_id, f.users.bob.employeeId)).response_status, "ACCEPTED");
    assert.equal((await responseOf(m.meeting_id, f.users.carol.employeeId)).response_status, "NO_RESPONSE");
    assert.equal((await responseOf(m.meeting_id, f.users.dave.employeeId)).response_status, "NO_RESPONSE");
  });

  it("queues one invitation per participant and none for the organizer", async () => {
    const result = await createBooking(input());

    assert.equal(result.invitationNotificationIds.length, 2);

    const rows = await db.select().from(notifications);
    const invites = rows.filter((n) => n.recipient_employee_id !== null);

    assert.deepEqual(
      invites.map((n) => n.recipient_employee_id).sort(),
      [f.users.carol.employeeId, f.users.dave.employeeId].sort()
    );
  });

  it("books without participants and sends no invitation", async () => {
    const result = await createBooking(input({ participantEmployeeIds: [], participantCount: 1 }));

    assert.equal(result.invitationNotificationIds.length, 0);
  });

  it("allows a headcount above the room's capacity", async () => {
    // Beta seats 4; five invited people plus the organizer.
    const { meetings: [m] } = await createBooking(
      input({
        roomId: f.rooms.beta.room_id,
        participantCount: 4,
        participantEmployeeIds: [f.users.carol.employeeId, f.users.dave.employeeId, f.users.manager.employeeId],
      })
    );
    assert.equal(m.participantCount, 4);

    const crowded = await createBooking(
      input({
        roomId: f.rooms.beta.room_id,
        startTime: "12:00",
        endTime: "13:00",
        participantCount: 6,
        participantEmployeeIds: [f.users.carol.employeeId],
      })
    );
    assert.equal(crowded.meetings[0].participantCount, 6, "no capacity check on the count");
  });
});

describe("invitation e-mail", () => {
  it("each participant gets their own invitation; the organizer gets the confirmation", async () => {
    const result = await createBooking(input());

    assert.equal(await deliverNotification(result.notificationId), "SENT");

    for (const id of result.invitationNotificationIds) {
      assert.equal(await deliverNotification(id), "SENT");
    }

    assert.equal(mail.sent.length, 3);

    const confirmation = mail.sent.find((m) => m.to === f.users.bob.email)!;
    const carol = mail.sent.find((m) => m.to === f.users.carol.email)!;
    const dave = mail.sent.find((m) => m.to === f.users.dave.email)!;

    assert.match(confirmation.subject, /Meeting Scheduled/);
    assert.match(carol.subject, /Meeting Invitation - Planning/);

    for (const m of [carol, dave]) {
      assert.ok(m.text.includes("Title: Planning"));
      assert.ok(m.text.includes(`Organizer: ${f.users.bob.name}`));
      assert.ok(m.text.includes(`Room: ${f.rooms.alpha.room_name}`));
      assert.ok(m.text.includes("Start Time: 10:00:00"));
      assert.ok(m.text.includes("End Time: 11:00:00"));
      assert.match(m.text, /Accept: http\S+\/invite\?/);
      assert.match(m.text, /Decline: http\S+\/invite\?/);
      assert.ok(m.ics.includes("BEGIN:VEVENT"), "calendar invite attached");
    }

    // The links are personal: Carol's cannot answer for Dave.
    const link = (text: string) => text.match(/Accept: (\S+)/)![1];

    assert.notEqual(link(carol.text), link(dave.text));
  });

  it("is sent once, and retried only for the participant whose mail failed", async () => {
    const result = await createBooking(input());
    const [first, second] = result.invitationNotificationIds;

    mail.setFailures(1);
    assert.equal(await deliverNotification(first), "RETRY");
    assert.equal(await deliverNotification(second), "SENT");
    assert.equal(await deliverNotification(first), "SENT");
    assert.equal(await deliverNotification(first), "SKIPPED", "never twice");

    assert.equal(mail.sent.length, 2);
  });

  it("is skipped when the meeting was cancelled before delivery", async () => {
    const result = await createBooking(input());

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.CANCELLED });

    assert.equal(await deliverNotification(result.invitationNotificationIds[0]), "SKIPPED");
    assert.equal(mail.sent.length, 0);
  });
});

describe("responding to an invitation", () => {
  it("records Accepted and Declined, with the time", async () => {
    const { meetings: [m] } = await createBooking(input());

    assert.deepEqual(
      await respondToInvitation(m.meeting_id, f.users.carol.employeeId, "accept"),
      { status: "recorded", response: "ACCEPTED" }
    );
    assert.deepEqual(
      await respondToInvitation(m.meeting_id, f.users.dave.employeeId, "decline"),
      { status: "recorded", response: "DECLINED" }
    );

    const carol = await responseOf(m.meeting_id, f.users.carol.employeeId);
    assert.equal(carol.response_status, "ACCEPTED");
    assert.ok(carol.responded_at);
    assert.equal((await responseOf(m.meeting_id, f.users.dave.employeeId)).response_status, "DECLINED");
  });

  it("cannot be answered twice: the first answer stands", async () => {
    const { meetings: [m] } = await createBooking(input());

    await respondToInvitation(m.meeting_id, f.users.carol.employeeId, "accept");

    assert.deepEqual(
      await respondToInvitation(m.meeting_id, f.users.carol.employeeId, "decline"),
      { status: "already", response: "ACCEPTED" }
    );
    assert.equal((await responseOf(m.meeting_id, f.users.carol.employeeId)).response_status, "ACCEPTED");
  });

  it("two simultaneous clicks produce exactly one recorded answer", async () => {
    const { meetings: [m] } = await createBooking(input());

    const results = await Promise.all([
      respondToInvitation(m.meeting_id, f.users.carol.employeeId, "accept"),
      respondToInvitation(m.meeting_id, f.users.carol.employeeId, "decline"),
      respondToInvitation(m.meeting_id, f.users.carol.employeeId, "accept"),
    ]);

    assert.equal(results.filter((r) => r.status === "recorded").length, 1);
    assert.equal(results.filter((r) => r.status === "already").length, 2);
  });

  it("the organizer's own answer is already given", async () => {
    const { meetings: [m] } = await createBooking(input());

    assert.equal(
      (await respondToInvitation(m.meeting_id, f.users.bob.employeeId, "decline")).status,
      "already"
    );
  });

  it("is refused for someone who was not invited", async () => {
    const { meetings: [m] } = await createBooking(input());

    assert.deepEqual(
      await respondToInvitation(m.meeting_id, f.users.manager.employeeId, "accept"),
      { status: "not-found" }
    );
    assert.equal(await getInvitationInfo(m.meeting_id, f.users.manager.employeeId), null);
  });

  it("is refused once the meeting is cancelled or over", async () => {
    const { meetings: [m] } = await createBooking(input());

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.CANCELLED });
    const cancelled = await respondToInvitation(m.meeting_id, f.users.carol.employeeId, "accept");

    assert.equal(cancelled.status, "closed");
    assert.equal((await responseOf(m.meeting_id, f.users.carol.employeeId)).response_status, "NO_RESPONSE");

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.SCHEDULED, meeting_date: dateFromToday(-2) });
    assert.equal(
      (await respondToInvitation(m.meeting_id, f.users.carol.employeeId, "accept")).status,
      "closed"
    );
  });

  it("an answer to a recurring series covers every occurrence", async () => {
    const dates = [dateFromToday(7), dateFromToday(14), dateFromToday(21)];
    const { meetings } = await createBooking(
      input({ occurrenceDates: dates, recurrence: { frequencyId: 2, occurrenceCount: 3 } })
    );

    await respondToInvitation(meetings[0].meeting_id, f.users.carol.employeeId, "decline");

    for (const m of meetings) {
      assert.equal(
        (await responseOf(m.meeting_id, f.users.carol.employeeId)).response_status,
        "DECLINED",
        m.meeting_date
      );
    }

    // Dave has not answered anything.
    assert.equal(
      (await responseOf(meetings[2].meeting_id, f.users.dave.employeeId)).response_status,
      "NO_RESPONSE"
    );
  });

  it("describes the invitation for the confirmation page", async () => {
    const { meetings: [m] } = await createBooking(input());

    const info = (await getInvitationInfo(m.meeting_id, f.users.carol.employeeId))!;

    assert.equal(info.meetingTitle, "Planning");
    assert.equal(info.organizerName, f.users.bob.name);
    assert.equal(info.roomName, "Alpha");
    assert.equal(info.participantName, f.users.carol.name);
    assert.equal(info.response, "NO_RESPONSE");
    assert.equal(info.closedReason, null);
  });
});
