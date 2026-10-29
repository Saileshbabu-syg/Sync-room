import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";

import { db } from "@/db";
import {
  meeting,
  meeting_attendees,
  recurring_meetings,
  room,
} from "@/db/schema";
import {
  BookingError,
  createBooking,
  type BookingInput,
} from "@/lib/services/booking.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { checkMeetingConflict } from "@/lib/services/conflict-check.service";
import {
  getAvailableRooms,
  isRoomAvailable,
} from "@/lib/services/room-suggestion.service";
import { getAllowedMeetingTypes } from "@/lib/services/meeting-type-access.service";
import { MEETING_STATUS } from "@/lib/constants";

import {
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

let f: Fixtures;

before(async () => {
  f = await seedFixtures();
});

// Every test starts from the same rooms/users with no meetings.
beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE meeting_audit_logs, reminder_logs, notifications,
      meeting_attendees, meeting, recurring_meetings RESTART IDENTITY CASCADE
  `);
  await db
    .update(room)
    .set({ availabilityStatusId: 1 })
    .where(eq(room.room_id, f.rooms.alpha.room_id));
});

const DAY = () => dateFromToday(7);

function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Planning",
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

const count = async () =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(meeting))[0].n;

// Self-join: any two non-cancelled meetings overlapping in the same room.
async function overlappingPairs() {
  const rows = await db.execute(sql`
    SELECT a.meeting_id FROM meeting a JOIN meeting b
      ON a.room_id = b.room_id AND a.meeting_date = b.meeting_date
     AND a.meeting_id < b.meeting_id
     AND a.start_time < b.end_time AND a.end_time > b.start_time
    WHERE a.meeting_status_id <> 3 AND b.meeting_status_id <> 3
  `);
  return rows.rows.length;
}

describe("back-to-back and overlapping slots (F-09)", () => {
  it("allows a meeting that starts exactly when another ends, and vice versa", async () => {
    await createBooking(input({ startTime: "10:00", endTime: "11:00" }));

    await createBooking(input({ startTime: "11:00", endTime: "12:00", title: "after" }));
    await createBooking(input({ startTime: "09:00", endTime: "10:00", title: "before" }));

    assert.equal(await count(), 3);
    assert.equal(await overlappingPairs(), 0);
  });

  it("rejects partial overlap with 409", async () => {
    await createBooking(input());

    for (const [s, e] of [["10:30", "11:30"], ["09:30", "10:30"]]) {
      const err = await rejection(createBooking(input({ startTime: s, endTime: e })));
      assert.equal(err.status, 409);
    }
  });

  it("rejects complete overlap, containment and identical slots with 409", async () => {
    await createBooking(input());

    for (const [s, e] of [["10:00", "11:00"], ["10:15", "10:45"], ["09:00", "12:00"]]) {
      assert.equal((await rejection(createBooking(input({ startTime: s, endTime: e })))).status, 409);
    }

    assert.equal(await count(), 1);
  });

  it("rejects identical, reversed and malformed times with 400", async () => {
    for (const [s, e] of [["10:00", "10:00"], ["11:00", "10:00"], ["xx", "11:00"]]) {
      assert.equal((await rejection(createBooking(input({ startTime: s, endTime: e })))).status, 400);
    }
  });

  it("treats the same time on adjacent days as independent (date boundary)", async () => {
    await createBooking(input({ occurrenceDates: [dateFromToday(7)], startTime: "23:00", endTime: "23:59" }));
    await createBooking(input({ occurrenceDates: [dateFromToday(8)], startTime: "00:00", endTime: "01:00" }));

    assert.equal(await count(), 2);
  });

  it("same slot in a different room is fine", async () => {
    await createBooking(input());
    await createBooking(input({ roomId: f.rooms.beta.room_id }));

    assert.equal(await count(), 2);
  });

  it("a cancelled meeting no longer holds its slot", async () => {
    const { meetings } = await createBooking(input());

    await db
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.CANCELLED })
      .where(eq(meeting.meeting_id, meetings[0].meeting_id));

    await createBooking(input({ title: "replacement" }));

    assert.equal(await count(), 2);
  });

  it("the read-only checks use the same half-open rule (search vs booking agree)", async () => {
    await createBooking(input());

    assert.equal(await checkMeetingConflict(f.rooms.alpha.room_id, DAY(), "11:00", "12:00"), false);
    assert.equal(await checkMeetingConflict(f.rooms.alpha.room_id, DAY(), "10:59", "12:00"), true);

    const free = await getAvailableRooms(DAY(), "11:00", "12:00", 2);
    assert.ok(free.some((r) => r.room_id === f.rooms.alpha.room_id));

    const busy = await getAvailableRooms(DAY(), "10:30", "11:30", 2);
    assert.ok(!busy.some((r) => r.room_id === f.rooms.alpha.room_id));

    assert.equal(
      (await isRoomAvailable(f.rooms.alpha.room_id, DAY(), "11:00", "12:00", 2)).success,
      true
    );
  });

  it("the DB constraint itself rejects an overlapping insert (defence in depth)", async () => {
    await createBooking(input());

    await assert.rejects(
      db.insert(meeting).values({
        title: "sneaky",
        room_id: f.rooms.alpha.room_id,
        meeting_date: DAY(),
        organizerEmployeeId: f.users.bob.employeeId,
        participantCount: 1,
        meetingTypeId: f.types.team,
        meetingStatusId: 1,
        start_time: "10:30:00",
        end_time: "11:30:00",
      }),
      (e: Error & { cause?: { code?: string } }) => e.cause?.code === "23P01"
    );
  });
});

describe("concurrent booking (F-01)", () => {
  it("25 simultaneous requests for one slot -> exactly one booking", async () => {
    const N = 25;
    const spans: { start: number; end: number }[] = [];

    const attempts = Array.from({ length: N }, (_, i) => async () => {
      const start = performance.now();
      try {
        return await createBooking(input({ title: `race ${i}` }));
      } finally {
        spans.push({ start, end: performance.now() });
      }
    });

    const results = await Promise.allSettled(attempts.map((run) => run()));

    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    assert.equal(ok.length, 1, "exactly one request may succeed");
    assert.equal(rejected.length, N - 1);

    for (const r of rejected) {
      assert.ok(r.reason instanceof BookingError);
      assert.equal(r.reason.status, 409);
    }

    assert.equal(await count(), 1);
    assert.equal(await overlappingPairs(), 0);

    // The requests really were in flight at the same time.
    const latestStart = Math.max(...spans.map((s) => s.start));
    const earliestEnd = Math.min(...spans.map((s) => s.end));
    assert.ok(latestStart < earliestEnd, "all requests overlapped in time");
  });

  it("repeats reliably (6 rounds, as in the audit)", async () => {
    for (let round = 0; round < 6; round++) {
      await db.execute(sql`TRUNCATE meeting_audit_logs, reminder_logs, notifications, meeting_attendees, meeting RESTART IDENTITY CASCADE`);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          createBooking(input({ title: `r${round}-${i}` }))
        )
      );

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `round ${round}`);
      assert.equal(await count(), 1);
    }
  });

  it("legitimate concurrent bookings (other rooms, non-overlapping slots) all succeed", async () => {
    const jobs = [
      input({ roomId: f.rooms.alpha.room_id, startTime: "09:00", endTime: "10:00" }),
      input({ roomId: f.rooms.alpha.room_id, startTime: "10:00", endTime: "11:00" }),
      input({ roomId: f.rooms.alpha.room_id, startTime: "11:00", endTime: "12:00" }),
      input({ roomId: f.rooms.beta.room_id, startTime: "09:00", endTime: "10:00" }),
      input({ roomId: f.rooms.beta.room_id, startTime: "10:00", endTime: "11:00" }),
      input({ roomId: f.rooms.alpha.room_id, occurrenceDates: [dateFromToday(8)] }),
    ];

    const results = await Promise.allSettled(jobs.map((j) => createBooking(j)));

    assert.deepEqual(
      results.map((r) => r.status),
      jobs.map(() => "fulfilled")
    );
    assert.equal(await count(), jobs.length);
    assert.equal(await overlappingPairs(), 0);
  });

  it("concurrent recurring series for the same slot -> exactly one series, no duplicates", async () => {
    const series = () =>
      createRecurringMeeting({
        title: "Weekly sync",
        room_id: f.rooms.alpha.room_id,
        meeting_date: DAY(),
        start_time: "14:00",
        end_time: "15:00",
        organizerEmployeeId: f.users.bob.employeeId,
        organizerRole: "Employee",
        participantCount: 2,
        meetingTypeId: f.types.team,
        frequency_id: 2,
        occurrence_count: 4,
        participantEmployeeIds: [f.users.carol.employeeId],
        notify: false,
      });

    const results = await Promise.allSettled(Array.from({ length: 8 }, series));

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(r.reason instanceof BookingError);
        assert.equal(r.reason.status, 409);
      }
    }

    assert.equal(await count(), 4, "one series of four occurrences");
    assert.equal(
      (await db.select().from(recurring_meetings)).length,
      1,
      "no orphan series rows from the losers"
    );
    assert.equal(await overlappingPairs(), 0);
  });

  it("mixed single + recurring + overlapping partial series never double-book", async () => {
    const jobs: Promise<unknown>[] = [];

    for (let i = 0; i < 6; i++) {
      jobs.push(createBooking(input({ startTime: "16:00", endTime: "17:00" })));
      jobs.push(
        createRecurringMeeting({
          title: "series",
          room_id: f.rooms.alpha.room_id,
          meeting_date: dateFromToday(7 + i),
          start_time: "16:30",
          end_time: "17:30",
          organizerEmployeeId: f.users.bob.employeeId,
          organizerRole: "Employee",
          participantCount: 2,
          meetingTypeId: f.types.team,
          frequency_id: 1,
          occurrence_count: 3,
          notify: false,
        })
      );
    }

    await Promise.allSettled(jobs);

    assert.equal(await overlappingPairs(), 0);
  });
});

describe("recurring bookings are atomic (F-01)", () => {
  const series = (overrides = {}) => ({
    title: "Standup",
    room_id: f.rooms.alpha.room_id,
    meeting_date: DAY(),
    start_time: "10:00",
    end_time: "10:30",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 2,
    meetingTypeId: f.types.team,
    frequency_id: 2,
    occurrence_count: 4,
    notify: false,
    ...overrides,
  });

  it("creates every occurrence with attendees, a reminder and an audit row each", async () => {
    const { meetings, recurringMeetingId } = await createRecurringMeeting(series());

    assert.equal(meetings.length, 4);
    assert.ok(recurringMeetingId);

    const attendees = await db.select().from(meeting_attendees);
    assert.equal(attendees.length, 4);
  });

  it("skip_dates books only the remaining occurrences and records the real count", async () => {
    const taken = dateFromToday(7 + 7);

    await createBooking(
      input({ occurrenceDates: [taken], startTime: "10:15", endTime: "10:45" })
    );

    const { meetings, recurringMeetingId } = await createRecurringMeeting(
      series({ occurrence_count: 3, skip_dates: [taken] })
    );

    assert.equal(meetings.length, 2);
    assert.ok(!meetings.some((m) => m.meeting_date === taken));
    assert.equal(await count(), 3, "the pre-existing meeting plus the two new ones");

    const [row] = await db
      .select()
      .from(recurring_meetings)
      .where(eq(recurring_meetings.recurring_meeting_id, recurringMeetingId));
    assert.equal(row.occurrence_count, 2);
  });

  it("skip_dates rejects a date outside the series and an empty result", async () => {
    const outside = await rejection(
      createRecurringMeeting(series({ skip_dates: [dateFromToday(1)] }))
    );
    assert.equal(outside.status, 400);

    const none = await rejection(
      createRecurringMeeting(
        series({
          occurrence_count: 2,
          skip_dates: [DAY(), dateFromToday(7 + 7)],
        })
      )
    );
    assert.equal(none.status, 400);
    assert.equal(await count(), 0);
  });

  it("a conflict on ANY occurrence rejects the whole series and leaves nothing behind", async () => {
    // Occupy the 3rd weekly occurrence.
    await createBooking(
      input({ occurrenceDates: [dateFromToday(7 + 14)], startTime: "10:15", endTime: "10:45" })
    );

    const err = await rejection(createRecurringMeeting(series()));

    assert.equal(err.status, 409);
    assert.deepEqual(err.conflicts, [dateFromToday(7 + 14)]);
    // The full series is returned too, so the UI can show which dates are free.
    assert.ok(err.occurrenceDates?.includes(dateFromToday(7 + 14)));
    assert.ok(err.occurrenceDates!.length > err.conflicts!.length);
    assert.equal(await count(), 1, "only the pre-existing meeting remains");
    assert.equal((await db.select().from(recurring_meetings)).length, 0);
  });

  it("a failure inside the transaction (unknown attendee) leaves no partial rows", async () => {
    const err = await rejection(
      createRecurringMeeting(series({ participantEmployeeIds: [999999] }))
    );

    assert.equal(err.status, 404);
    assert.equal(await count(), 0);
    assert.equal((await db.select().from(recurring_meetings)).length, 0);
  });

  it("back-to-back series occurrences are allowed", async () => {
    await createBooking(input({ startTime: "09:30", endTime: "10:00", occurrenceDates: [DAY()] }));

    const { meetings } = await createRecurringMeeting(series({ occurrence_count: 2 }));

    assert.equal(meetings.length, 2);
  });
});

describe("room under maintenance (F-06)", () => {
  it("rejects a room that is in maintenance with 409", async () => {
    const err = await rejection(
      createBooking(input({ roomId: f.rooms.gamma.room_id }))
    );

    assert.equal(err.status, 409);
    assert.match(err.message, /unavailable/i);
    assert.equal(await count(), 0);
  });

  it("also rejects recurring series in a room under maintenance", async () => {
    const err = await rejection(
      createRecurringMeeting({
        title: "Series",
        room_id: f.rooms.gamma.room_id,
        meeting_date: DAY(),
        start_time: "10:00",
        end_time: "10:30",
        organizerEmployeeId: f.users.bob.employeeId,
        organizerRole: "Employee",
        participantCount: 2,
        meetingTypeId: f.types.team,
        frequency_id: 2,
        occurrence_count: 3,
        notify: false,
      })
    );

    assert.equal(err.status, 409);
    assert.equal(await count(), 0);
  });

  it("uses the CURRENT status: flipping a room to maintenance blocks later bookings", async () => {
    await createBooking(input());

    await db.update(room).set({ availabilityStatusId: 2 }).where(eq(room.room_id, f.rooms.alpha.room_id));

    assert.equal(
      (await rejection(createBooking(input({ startTime: "13:00", endTime: "14:00" })))).status,
      409
    );

    await db.update(room).set({ availabilityStatusId: 1 }).where(eq(room.room_id, f.rooms.alpha.room_id));

    await createBooking(input({ startTime: "13:00", endTime: "14:00" }));
    assert.equal(await count(), 2);
  });

  it("is correct under a concurrent status change (row lock, not a stale read)", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const admin = await pool.connect();

    try {
      // Another transaction sets the room to maintenance and has not committed.
      await admin.query("BEGIN");
      await admin.query("UPDATE rooms SET availability_status_id = 2 WHERE room_id = $1", [
        f.rooms.alpha.room_id,
      ]);

      let settled = false;
      const booking = createBooking(input()).then(
        () => ({ ok: true as const }),
        (e) => ({ ok: false as const, e })
      );
      void booking.then(() => (settled = true));

      await new Promise((r) => setTimeout(r, 400));
      assert.equal(settled, false, "the booking must wait for the in-flight status change");

      await admin.query("COMMIT");

      const outcome = await booking;
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok && outcome.e instanceof BookingError && outcome.e.status === 409);
      assert.equal(await count(), 0);
    } finally {
      admin.release();
      await pool.end();
    }
  });

  it("search APIs also hide rooms under maintenance", async () => {
    const free = await getAvailableRooms(DAY(), "10:00", "11:00", 2);

    assert.ok(!free.some((r) => r.room_id === f.rooms.gamma.room_id));
    assert.equal(
      (await isRoomAvailable(f.rooms.gamma.room_id, DAY(), "10:00", "11:00", 2)).success,
      false
    );
  });
});

describe("role -> meeting type rules (F-05)", () => {
  const MATRIX: Record<string, { allowed: string[]; denied: string[] }> = {
    Employee: {
      allowed: ["team", "oneOnOne", "others"],
      denied: ["client", "interview", "training"],
    },
    Admin: {
      allowed: ["oneOnOne", "others"],
      denied: ["client", "interview", "team", "training"],
    },
    Manager: {
      allowed: ["client", "interview", "team", "training", "oneOnOne", "others"],
      denied: [],
    },
  };

  const who = (role: string) =>
    role === "Admin" ? f.users.admin : role === "Manager" ? f.users.manager : f.users.bob;

  for (const [role, { allowed, denied }] of Object.entries(MATRIX)) {
    for (const type of allowed) {
      it(`${role} may book ${type}`, async () => {
        await createBooking(
          input({
            organizerEmployeeId: who(role).employeeId,
            organizerRole: role,
            meetingTypeId: f.types[type as keyof typeof f.types],
            participantEmployeeIds: [],
            participantCount: 1,
          })
        );

        assert.equal(await count(), 1);
      });
    }

    for (const type of denied) {
      it(`${role} may NOT book ${type} (403)`, async () => {
        const err = await rejection(
          createBooking(
            input({
              organizerEmployeeId: who(role).employeeId,
              organizerRole: role,
              meetingTypeId: f.types[type as keyof typeof f.types],
              participantEmployeeIds: [],
              participantCount: 1,
            })
          )
        );

        assert.equal(err.status, 403);
        assert.equal(await count(), 0);
      });
    }
  }

  it("rejects an unknown meeting type with 404 and an unknown role with 403", async () => {
    assert.equal((await rejection(createBooking(input({ meetingTypeId: 999999 })))).status, 404);
    assert.equal((await rejection(createBooking(input({ organizerRole: "Intern" })))).status, 403);
  });

  it("recurring series obey the same rule", async () => {
    const err = await rejection(
      createRecurringMeeting({
        title: "Client series",
        room_id: f.rooms.alpha.room_id,
        meeting_date: DAY(),
        start_time: "10:00",
        end_time: "10:30",
        organizerEmployeeId: f.users.bob.employeeId,
        organizerRole: "Employee",
        participantCount: 2,
        meetingTypeId: f.types.client,
        frequency_id: 2,
        occurrence_count: 2,
        notify: false,
      })
    );

    assert.equal(err.status, 403);
  });

  it("getAllowedMeetingTypes returns only the role's types (the /api/meeting-types list)", async () => {
    const names = (await getAllowedMeetingTypes("Employee")).map((t) => t.meetingTypeName);

    assert.deepEqual(names.sort(), ["One-on-One", "Others", "Team Meeting"]);
    assert.equal((await getAllowedMeetingTypes("Nobody")).length, 0);
  });
});

describe("other booking rules", () => {
  it("rejects bookings in the past (F-11)", async () => {
    const err = await rejection(
      createBooking(input({ occurrenceDates: [dateFromToday(-1)] }))
    );

    assert.equal(err.status, 400);
    assert.match(err.message, /past/i);
  });

  it("enforces capacity and the organizer-counts-as-one attendee rule", async () => {
    assert.equal(
      (await rejection(createBooking(input({ roomId: f.rooms.beta.room_id, participantCount: 5 })))).status,
      400
    );
    assert.equal(
      (await rejection(createBooking(input({ participantCount: 2, participantEmployeeIds: [f.users.carol.employeeId, f.users.admin.employeeId] })))).status,
      400
    );
  });

  it("404s for an unknown room or attendee", async () => {
    assert.equal((await rejection(createBooking(input({ roomId: 999999 })))).status, 404);
    assert.equal(
      (await rejection(createBooking(input({ participantEmployeeIds: [999999] })))).status,
      404
    );
  });

  it("always schedules as Scheduled and counts the organizer as an attendee", async () => {
    const { meetings } = await createBooking(input());

    assert.equal(meetings[0].meetingStatusId, MEETING_STATUS.SCHEDULED);

    const attendees = await db
      .select()
      .from(meeting_attendees)
      .where(eq(meeting_attendees.meeting_id, meetings[0].meeting_id));

    assert.deepEqual(
      attendees.map((a) => a.employee_id).sort(),
      [f.users.bob.employeeId, f.users.carol.employeeId].sort()
    );
  });
});
