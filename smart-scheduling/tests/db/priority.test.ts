import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, reschedule_requests, room } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  type BookingInput,
} from "@/lib/services/booking.service";
import { deliverNotification } from "@/lib/services/notification.service";
import { getClaimableRooms } from "@/lib/services/priority.service";

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
    TRUNCATE meeting_audit_logs, reminder_logs, notifications,
      reschedule_requests, meeting_attendees, meeting, recurring_meetings
    RESTART IDENTITY CASCADE
  `);
  await db
    .update(room)
    .set({ availabilityStatusId: 1 })
    .where(eq(room.room_id, f.rooms.alpha.room_id));
});

const DAY = () => dateFromToday(7);

// Alpha, 10:00-11:00, booked as the employee's team meeting unless overridden.
function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Team sync",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [DAY()],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 2,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [f.users.carol.employeeId],
    notify: false,
    ...overrides,
  };
}

// The higher-priority booking: a manager's interview in the same slot.
function interview(overrides: Partial<BookingInput> = {}): BookingInput {
  return input({
    title: "Candidate interview",
    organizerEmployeeId: f.users.manager.employeeId,
    organizerRole: "Manager",
    meetingTypeId: f.types.interview,
    participantEmployeeIds: [],
    participantCount: 1,
    ...overrides,
  });
}

async function rejection(promise: Promise<unknown>): Promise<BookingError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BookingError, `expected BookingError, got ${error}`);
    return error;
  }

  assert.fail("expected the booking to be rejected");
}

async function meetingById(id: number) {
  const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, id));
  return row;
}

describe("priority-based booking", () => {
  it("moves the lower-priority meeting to another free room and e-mails its attendees", async () => {
    const { meetings: [low] } = await createBooking(input());

    const result = await createBooking(interview());

    const bumped = await meetingById(low.meeting_id);
    assert.equal(bumped.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(bumped.room_id, f.rooms.beta.room_id, "moved to the free room that fits");

    const claimant = await meetingById(result.meetings[0].meeting_id);
    assert.equal(claimant.room_id, f.rooms.alpha.room_id);

    const [request] = await db.select().from(reschedule_requests);
    assert.equal(request.status, "AUTO_REALLOCATED");
    assert.equal(request.bumped_meeting_id, low.meeting_id);
    assert.equal(request.claimant_meeting_id, claimant.meeting_id);

    assert.equal(result.otherNotificationIds.length, 1);
    assert.equal(await deliverNotification(result.otherNotificationIds[0]), "SENT");

    const [m] = mail.sent;
    assert.ok(m.to.includes(f.users.bob.email), "the previous organizer is told");
    assert.ok(m.to.includes(f.users.carol.email), "and so are its attendees");
    assert.match(m.text, /higher-priority meeting \(Interview booked by Mona Manager\)/);
    assert.match(m.text, /moved from Alpha to Beta/);
    assert.notEqual(m.ics, "", "the updated invite is attached");
  });

  it("cancels the lower-priority meeting and asks its organizer to rebook when no room is free", async () => {
    // Beta is taken by a top-priority client meeting; Gamma is unavailable.
    await createBooking(
      input({
        roomId: f.rooms.beta.room_id,
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
        participantEmployeeIds: [],
        participantCount: 1,
      })
    );
    const { meetings: [low] } = await createBooking(input());

    const result = await createBooking(interview());

    const bumped = await meetingById(low.meeting_id);
    assert.equal(bumped.meetingStatusId, MEETING_STATUS.CANCELLED);

    const [request] = await db.select().from(reschedule_requests);
    assert.equal(request.status, "AUTO_CANCELLED");

    await deliverNotification(result.otherNotificationIds[0]);

    const [m] = mail.sent;
    assert.match(m.subject, /Meeting Cancelled/);
    assert.match(m.text, /Please book another available slot/);
    assert.equal(m.ics, "", "no invite for a cancelled meeting");
  });

  it("never bumps a meeting of equal priority", async () => {
    await createBooking(input());

    const error = await rejection(
      createBooking(
        input({
          title: "Other team sync",
          organizerEmployeeId: f.users.carol.employeeId,
          participantEmployeeIds: [],
          participantCount: 1,
        })
      )
    );

    assert.equal(error.status, 409);
    assert.equal((await db.select().from(reschedule_requests)).length, 0);
  });

  it("never bumps a higher-priority meeting", async () => {
    const { meetings: [high] } = await createBooking(interview());

    const error = await rejection(createBooking(input()));

    assert.equal(error.status, 409);
    assert.equal((await meetingById(high.meeting_id)).room_id, f.rooms.alpha.room_id);
  });

  it("does not bump anything when one of the meetings in the way outranks the request", async () => {
    // 10:00-10:30 low priority, 10:30-11:00 top priority.
    const { meetings: [low] } = await createBooking(input({ endTime: "10:30" }));
    await createBooking(
      input({
        startTime: "10:30",
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
        participantEmployeeIds: [],
        participantCount: 1,
      })
    );

    const error = await rejection(createBooking(interview()));

    assert.equal(error.status, 409);
    const untouched = await meetingById(low.meeting_id);
    assert.equal(untouched.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(untouched.room_id, f.rooms.alpha.room_id);
  });

  it("lists rooms a role could claim, but not rooms held by equal or higher priority", async () => {
    await createBooking(input());

    const manager = await getClaimableRooms("Manager", DAY(), "10:00", "11:00", 1);
    assert.deepEqual(
      manager.map((r) => r.room_id),
      [f.rooms.alpha.room_id]
    );

    // An Employee's best type (Team Meeting) is the same rank as the holder.
    assert.deepEqual(await getClaimableRooms("Employee", DAY(), "10:00", "11:00", 1), []);
  });
});
