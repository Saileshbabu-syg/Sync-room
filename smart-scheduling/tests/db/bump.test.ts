import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, room } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  type BookingInput,
} from "@/lib/services/booking.service";
import { previewBooking } from "@/lib/services/bump.service";

import {
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

let f: Fixtures;

before(async () => {
  f = await seedFixtures();
});

beforeEach(async () => {
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

// A booking by Bob (Employee) of a Team Meeting (rank 3) unless overridden.
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

async function rejection(promise: Promise<unknown>): Promise<BookingError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BookingError, `expected BookingError, got ${error}`);
    return error;
  }

  assert.fail("expected the booking to be rejected");
}

// Mona (Manager) booking a Client Meeting (rank 1) over the same slot.
function clientInput(overrides: Partial<BookingInput> = {}): BookingInput {
  return input({
    title: "Client call",
    organizerEmployeeId: f.users.manager.employeeId,
    organizerRole: "Manager",
    meetingTypeId: f.types.client,
    participantCount: 1,
    participantEmployeeIds: [],
    ...overrides,
  });
}

const meetingRows = () =>
  db.select().from(meeting).orderBy(meeting.meeting_id);

describe("previewBooking (seam 2)", () => {
  it("reports a slot held by a lower-priority meeting as bumpable, naming it", async () => {
    const booked = await createBooking(input());
    const victimId = booked.meetings[0].meeting_id;

    const preview = await previewBooking({
      roomId: f.rooms.alpha.room_id,
      meetingDate: DAY(),
      startTime: "10:00",
      endTime: "11:00",
      meetingTypeId: f.types.client,
    });

    assert.equal(preview.state, "BUMPABLE");
    assert.deepEqual(
      preview.state === "BUMPABLE" ? preview.victims.map((v) => v.meetingId) : [],
      [victimId]
    );
  });

  it("rejects an unknown meeting type as not found", async () => {
    await assert.rejects(
      previewBooking({
        roomId: f.rooms.alpha.room_id,
        meetingDate: DAY(),
        startTime: "10:00",
        endTime: "11:00",
        meetingTypeId: 999999,
      }),
      (error) => error instanceof BookingError && error.status === 404
    );
  });
});

describe("createBooking with a bump (seam 3)", () => {
  it("asks for confirmation instead of booking over a lower-priority meeting, and changes nothing", async () => {
    const victim = (await createBooking(input())).meetings[0];

    const error = await rejection(createBooking(clientInput()));

    assert.equal(error.status, 409);
    assert.equal(error.code, "BUMP_CONFIRMATION_REQUIRED");
    assert.deepEqual(
      error.victims?.map((v) => v.meetingId),
      [victim.meeting_id]
    );

    const rows = await meetingRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meetingStatusId, MEETING_STATUS.SCHEDULED);
  });
});
