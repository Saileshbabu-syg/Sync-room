import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, reminder_logs } from "@/db/schema";
import { monthOf, weekOf } from "@/lib/booking-limits";
import { MEETING_STATUS } from "@/lib/constants";
import { addDays } from "@/lib/report-period";
import { appWallClockToUtc, slotEndDate } from "@/lib/time";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import { getDashboardMetrics } from "@/lib/services/booking-dashboard.service";
import { updateAppBookingSettings } from "@/lib/services/booking-settings.service";
import { checkMeetingConflict } from "@/lib/services/conflict-check.service";
import { updateCompletedMeetings } from "@/lib/services/meeting-status.service";
import { updateGroup } from "@/lib/services/group.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { rescheduleMeeting } from "@/lib/services/reschedule.service";
import { getRoomSchedule } from "@/lib/services/room-suggestion.service";
import { setRoomArchived } from "@/lib/services/room.service";
import { cancelMeetings } from "@/lib/services/series.service";
import type { AppBookingSettingsInput } from "@/lib/validations/booking-settings.validator";
import type { UpdateGroupInput } from "@/lib/validations/group.validator";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";

// Overnight bookings: a meeting that starts on one day and ends on the next
// (end time earlier than start time). One date, two times, the end date is
// derived (lib/time.ts); the room-overlap exclusion constraint uses the same
// derivation (migration 0043).

type GroupSettings = NonNullable<UpdateGroupInput["settings"]>;

let f: Fixtures;
let admin: number;

before(async () => {
  f = await seedFixtures();
  admin = f.users.admin.employeeId;
});

const ALL = ["booking.create", "booking.view", "booking.cancel", "booking.priority", "booking.recurring"];

const APP_OPEN: AppBookingSettingsInput = {
  allowOvernight: true,
  maxDurationMinutes: null,
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

const GROUP_OPEN: GroupSettings = {
  maxDurationMinutes: null,
  maxAdvanceDays: null,
  maxOccurrences: null,
  overnightPolicy: "INHERIT",
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

const setApp = (over: Partial<AppBookingSettingsInput> = {}) =>
  updateAppBookingSettings({ ...APP_OPEN, ...over }, admin);

const setGroup = (groupId: number, over: Partial<GroupSettings> = {}) =>
  updateGroup(groupId, { settings: { ...GROUP_OPEN, ...over } }, admin);

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE booking_priority_history, meeting_audit_logs, reminder_logs,
      notifications, reschedule_requests, meeting_attendees, meeting,
      recurring_meetings, group_audit_logs
    RESTART IDENTITY CASCADE
  `);

  await db.execute(sql`UPDATE rooms SET archived_at = NULL, availability_status_id = 1 WHERE room_name IN ('Alpha', 'Beta')`);

  await setApp();

  for (const id of Object.values(f.groupIds)) {
    await updateGroup(id, { isActive: true, permissions: ALL, settings: GROUP_OPEN, roomIds: [] }, admin);
  }
});

const book = (over: Partial<BookingInput> = {}) =>
  createBooking({
    title: "Night shift sync",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [day(1)],
    startTime: "23:00",
    endTime: "01:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 1,
    meetingTypeId: f.types.team,
    notify: false,
    ...over,
  });

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string; conflicts?: string[] };
  }

  assert.fail("expected the call to be refused");
};

const liveMeetings = async () =>
  (await db.select().from(meeting)).filter((m) => m.meetingStatusId !== MEETING_STATUS.CANCELLED);

// A Monday far enough ahead that its whole week is bookable.
const MONDAY = weekOf(dateFromToday(15)).start;
const day = (offset: number) => addDays(MONDAY, offset);

const NEXT_MONTH = addDays(monthOf(dateFromToday(0)).end, 1);

describe("overnight policy", () => {
  it("is refused while the application switch is off", async () => {
    await setApp({ allowOvernight: false });

    const error = await failure(book());

    assert.equal(error.status, 403);
    assert.match(error.message, /Overnight bookings are not permitted/);
    assert.equal((await liveMeetings()).length, 0);

    // The same slot ending the same day is fine.
    await book({ startTime: "21:00", endTime: "23:00" });
  });

  it("is refused for a group set to Not allowed, allowed for Inherit and Allowed", async () => {
    await setGroup(f.groupIds.employee, { overnightPolicy: "NOT_ALLOWED" });

    assert.equal((await failure(book())).status, 403);

    await setGroup(f.groupIds.employee, { overnightPolicy: "ALLOWED" });
    await book({ occurrenceDates: [day(1)] });

    await setGroup(f.groupIds.employee, { overnightPolicy: "INHERIT" });
    await book({ occurrenceDates: [day(3)] });

    assert.equal((await liveMeetings()).length, 2);
  });

  it("books 11:00 PM-01:00 AM, 11:30 PM-12:30 AM and 10:00 PM-02:00 AM on their start dates", async () => {
    const cases = [
      { date: day(1), start: "23:00", end: "01:00", minutes: 120 },
      { date: day(2), start: "23:30", end: "00:30", minutes: 60 },
      { date: day(3), start: "22:00", end: "02:00", minutes: 240 },
    ];

    for (const c of cases) {
      const { meetings } = await book({ occurrenceDates: [c.date], startTime: c.start, endTime: c.end });

      assert.equal(meetings[0].meeting_date, c.date, "dated on the day it starts");
      assert.equal(slotEndDate(c.date, c.start, c.end), addDays(c.date, 1), "ends the next calendar day");

      const [row] = await db.execute<{ minutes: number }>(
        sql`SELECT extract(epoch FROM ((meeting_date + end_time + interval '1 day') - (meeting_date + start_time))) / 60 AS minutes
            FROM meeting WHERE meeting_id = ${meetings[0].meeting_id}`
      ).then((r) => r.rows);

      assert.equal(Number(row.minutes), c.minutes);
    }
  });

  it("applies the longest meeting to the real (cross-midnight) length", async () => {
    await setApp({ maxDurationMinutes: 150 });

    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" }); // 2 h

    const error = await failure(book({ occurrenceDates: [day(2)], startTime: "22:00", endTime: "02:00" })); // 4 h

    assert.equal(error.status, 400);
    assert.match(error.message, /at most 2 hours 30 minutes|at most 150 minutes/);
  });

  it("refuses a zero-length slot", async () => {
    const error = await failure(book({ startTime: "23:00", endTime: "23:00" }));

    assert.equal(error.status, 400);
  });
});

describe("room conflicts across midnight", () => {
  it("an overnight meeting blocks the early hours of the next day, but not back-to-back", async () => {
    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" });

    // Next morning, inside the meeting.
    assert.equal((await failure(book({ occurrenceDates: [day(2)], startTime: "00:00", endTime: "00:30" }))).status, 409);
    assert.equal((await failure(book({ occurrenceDates: [day(2)], startTime: "00:30", endTime: "01:30" }))).status, 409);

    // Starts exactly when it ends / ends exactly when it starts.
    await book({ occurrenceDates: [day(2)], startTime: "01:00", endTime: "02:00" });
    await book({ occurrenceDates: [day(1)], startTime: "22:00", endTime: "23:00" });

    // The evening before it ends is taken as well.
    assert.equal((await failure(book({ occurrenceDates: [day(1)], startTime: "22:00", endTime: "23:30" }))).status, 409);
    assert.equal((await failure(book({ occurrenceDates: [day(1)], startTime: "23:30", endTime: "23:59" }))).status, 409);
  });

  it("a meeting early next morning blocks an overnight slot that would run into it", async () => {
    await book({ occurrenceDates: [day(2)], startTime: "00:30", endTime: "01:30" });

    assert.equal((await failure(book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" }))).status, 409);

    // Ending exactly when it starts is fine.
    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "00:30" });
  });

  it("two overnight slots on the same night clash; consecutive nights do not; other rooms are free", async () => {
    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" });

    assert.equal((await failure(book({ occurrenceDates: [day(1)], startTime: "23:30", endTime: "00:30" }))).status, 409);

    await book({ occurrenceDates: [day(2)], startTime: "23:00", endTime: "01:00" });
    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00", roomId: f.rooms.beta.room_id });

    assert.equal((await liveMeetings()).length, 3);
  });

  it("a cancelled overnight meeting releases its slot", async () => {
    const { meetings } = await book({ occurrenceDates: [day(1)] });

    await cancelMeetings({
      meetingId: meetings[0].meeting_id,
      actor: { employeeId: f.users.bob.employeeId, role: "Employee" },
      scope: "single",
      notify: false,
    });

    await book({ occurrenceDates: [day(2)], startTime: "00:00", endTime: "00:30" });
  });

  it("the conflict check and the database constraint agree (direct insert across midnight is rejected)", async () => {
    const { meetings } = await book({ occurrenceDates: [day(1)] });

    assert.equal(await checkMeetingConflict(f.rooms.alpha.room_id, day(2), "00:15", "00:45"), true);
    assert.equal(await checkMeetingConflict(f.rooms.alpha.room_id, day(2), "01:00", "02:00"), false);

    const insert = (date: string, start: string, end: string) =>
      db.insert(meeting).values({
        title: "Raw",
        room_id: f.rooms.alpha.room_id,
        meeting_date: date,
        organizerEmployeeId: f.users.bob.employeeId,
        participantCount: 1,
        meetingTypeId: f.types.team,
        meetingStatusId: MEETING_STATUS.SCHEDULED,
        start_time: start,
        end_time: end,
      });

    await assert.rejects(insert(day(2), "00:15", "00:45"), (error: unknown) => {
      const cause = (error as { cause?: { code?: string } }).cause ?? (error as { code?: string });

      return cause.code === "23P01";
    });

    await insert(day(2), "01:00", "02:00");

    await assert.rejects(
      insert(day(1), "10:00", "10:00"),
      (error: unknown) => ((error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code) === "23514"
    );

    assert.ok(meetings.length === 1);
  });

  it("the room's day view shows the overnight meeting on both dates", async () => {
    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" });

    const viewer = { employeeId: f.users.bob.employeeId, role: "Employee" };
    const evening = await getRoomSchedule(f.rooms.alpha.room_id, day(1), viewer);
    const morning = await getRoomSchedule(f.rooms.alpha.room_id, day(2), viewer);

    assert.equal(evening.length, 1);
    assert.equal(evening[0].continuesNextDay, true);
    assert.equal(evening[0].fromPreviousDay, false);
    assert.equal(morning.length, 1);
    assert.equal(morning[0].fromPreviousDay, true);
    assert.equal(morning[0].continuesNextDay, false);
  });
});

describe("booking limits count the start date", () => {
  it("an overnight meeting counts once, on the day it starts", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" });

    // The next calendar day is untouched by it ...
    await book({ occurrenceDates: [day(2)], startTime: "10:00", endTime: "11:00" });

    // ... and the start day is full.
    const error = await failure(book({ occurrenceDates: [day(1)], startTime: "09:00", endTime: "10:00", organizerEmployeeId: f.users.carol.employeeId }));

    assert.equal(error.status, 400);
    assert.match(error.message, /per day/);
  });

  it("a Sunday-night meeting belongs to that Monday-to-Sunday week, not the next", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerWeek: 1 });

    await book({ occurrenceDates: [day(6)], startTime: "23:00", endTime: "01:00" }); // Sunday

    // Monday (the next week) is free ...
    await book({ occurrenceDates: [day(7)], startTime: "10:00", endTime: "11:00" });

    // ... the same week is full.
    assert.equal((await failure(book({ occurrenceDates: [day(2)], startTime: "10:00", endTime: "11:00" }))).status, 400);
  });

  it("the last night of a month belongs to that month", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerMonth: 1 });

    const lastDay = addDays(NEXT_MONTH, -1);

    await book({ occurrenceDates: [lastDay], startTime: "23:00", endTime: "01:00" });
    await book({ occurrenceDates: [NEXT_MONTH], startTime: "10:00", endTime: "11:00" });

    assert.equal(
      (await failure(book({ occurrenceDates: [addDays(lastDay, -3)], startTime: "10:00", endTime: "11:00" }))).status,
      400
    );
  });

  it("a lowered application limit leaves existing meetings alone; only new bookings and moves into a full day are refused", async () => {
    const ids: number[] = [];

    for (const h of [8, 10, 12]) {
      const { meetings } = await book({
        occurrenceDates: [day(1)],
        startTime: `${String(h).padStart(2, "0")}:00`,
        endTime: `${String(h + 1).padStart(2, "0")}:00`,
      });

      ids.push(meetings[0].meeting_id);
    }

    await setApp({ maxBookingsPerDay: 1 });

    // Nothing was cancelled or changed.
    const rows = await liveMeetings();

    assert.equal(rows.length, 3);
    assert.ok(rows.every((m) => m.meeting_date === day(1) && m.meetingStatusId === MEETING_STATUS.SCHEDULED));

    // New bookings follow the latest limit.
    assert.equal((await failure(book({ occurrenceDates: [day(1)], startTime: "14:00", endTime: "15:00" }))).status, 400);

    const actor = { employeeId: f.users.bob.employeeId, role: "Employee" };

    // Moving inside the same (already over) day is neutral ...
    await rescheduleMeeting({
      meetingId: ids[0], actor, roomId: f.rooms.alpha.room_id, meetingDate: day(1), startTime: "16:00", endTime: "17:00", notify: false,
    });

    // ... a move to an empty day is a new booking there and fits ...
    await rescheduleMeeting({
      meetingId: ids[1], actor, roomId: f.rooms.alpha.room_id, meetingDate: day(2), startTime: "10:00", endTime: "11:00", notify: false,
    });

    // ... but a second move there goes over the limit.
    const error = await failure(
      rescheduleMeeting({
        meetingId: ids[2], actor, roomId: f.rooms.alpha.room_id, meetingDate: day(2), startTime: "12:00", endTime: "13:00", notify: false,
      })
    );

    assert.equal(error.status, 400);
    assert.match(error.message, /per day/);
  });
});

describe("recurring overnight series", () => {
  const series = (count: number, start: string, over: Record<string, unknown> = {}) =>
    createRecurringMeeting({
      title: "Night series",
      room_id: f.rooms.alpha.room_id,
      meeting_date: start,
      start_time: "23:00",
      end_time: "01:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 1,
      meetingTypeId: f.types.team,
      frequency_id: 2, // weekly
      occurrence_count: count,
      notify: false,
      ...over,
    });

  it("books every occurrence across midnight when policy allows it", async () => {
    const result = await series(3, day(1));

    assert.equal(result.meetings.length, 3);
    assert.ok(result.meetings.every((m) => m.start_time.startsWith("23:00") && m.end_time.startsWith("01:00")));
  });

  it("is refused as a whole while overnight is off for the group", async () => {
    await setGroup(f.groupIds.employee, { overnightPolicy: "NOT_ALLOWED" });

    assert.equal((await failure(series(3, day(1)))).status, 403);
    assert.equal((await liveMeetings()).length, 0);
  });

  it("checks each occurrence's room conflict across midnight and lists the clashing dates", async () => {
    // Early morning of the day after the SECOND occurrence.
    await book({ occurrenceDates: [addDays(day(1), 8)], startTime: "00:30", endTime: "01:30" });

    const error = await failure(series(3, day(1)));

    assert.equal(error.status, 409);
    assert.deepEqual(error.conflicts, [addDays(day(1), 7)]);
    assert.equal((await liveMeetings()).length, 1, "nothing of the series was written");
  });

  it("validates each occurrence's duration and the booking limits as a whole", async () => {
    await setApp({ maxDurationMinutes: 60 });

    assert.equal((await failure(series(2, day(1)))).status, 400);

    await setApp({ maxBookingsPerMonth: 2 });

    const error = await failure(series(5, NEXT_MONTH));

    assert.equal(error.status, 400);
    assert.match(error.message, /per month/);
    assert.equal((await liveMeetings()).length, 0);
  });
});

describe("rescheduling and moving", () => {
  const actor = () => ({ employeeId: f.users.bob.employeeId, role: "Employee" });

  it("moves a same-day meeting to an overnight slot, keeping its id and bumping the calendar version", async () => {
    const { meetings } = await book({ occurrenceDates: [day(1)], startTime: "10:00", endTime: "11:00" });
    const id = meetings[0].meeting_id;

    await rescheduleMeeting({
      meetingId: id, actor: actor(), roomId: f.rooms.alpha.room_id, meetingDate: day(1), startTime: "23:00", endTime: "01:00", notify: false,
    });

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, id));

    assert.equal(row.start_time, "23:00:00");
    assert.equal(row.end_time, "01:00:00");
    assert.equal(row.ics_sequence, 1);
  });

  it("is refused when overnight is not permitted, and when the new slot runs into another meeting", async () => {
    const { meetings } = await book({ occurrenceDates: [day(1)], startTime: "10:00", endTime: "11:00" });
    const id = meetings[0].meeting_id;
    const move = (date: string, start: string, end: string) =>
      rescheduleMeeting({ meetingId: id, actor: actor(), roomId: f.rooms.alpha.room_id, meetingDate: date, startTime: start, endTime: end, notify: false });

    await setGroup(f.groupIds.employee, { overnightPolicy: "NOT_ALLOWED" });
    assert.equal((await failure(move(day(1), "23:00", "01:00"))).status, 403);

    await setGroup(f.groupIds.employee, { overnightPolicy: "INHERIT" });
    await book({ occurrenceDates: [day(2)], startTime: "00:30", endTime: "01:30", organizerEmployeeId: f.users.carol.employeeId });

    assert.equal((await failure(move(day(1), "23:00", "01:00"))).status, 409);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, id));

    assert.equal(row.start_time, "10:00:00", "a refused move changes nothing");
  });

  it("an existing overnight meeting survives the policy being switched off, but cannot be moved to another overnight slot", async () => {
    const { meetings } = await book({ occurrenceDates: [day(1)] });

    await setApp({ allowOvernight: false });

    assert.equal((await liveMeetings()).length, 1);

    const error = await failure(
      rescheduleMeeting({
        meetingId: meetings[0].meeting_id, actor: actor(), roomId: f.rooms.alpha.room_id, meetingDate: day(2), startTime: "23:00", endTime: "01:00", notify: false,
      })
    );

    assert.equal(error.status, 403);

    // Moving it to a same-day slot is allowed.
    await rescheduleMeeting({
      meetingId: meetings[0].meeting_id, actor: actor(), roomId: f.rooms.alpha.room_id, meetingDate: day(2), startTime: "09:00", endTime: "10:00", notify: false,
    });
  });
});

describe("concurrency across midnight", () => {
  it("of overlapping requests that straddle midnight, exactly one is booked", async () => {
    const results = await Promise.allSettled([
      book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" }),
      book({ occurrenceDates: [day(2)], startTime: "00:00", endTime: "01:00", organizerEmployeeId: f.users.carol.employeeId }),
      book({ occurrenceDates: [day(1)], startTime: "23:30", endTime: "00:30" }),
      book({ occurrenceDates: [day(2)], startTime: "00:15", endTime: "00:45", organizerEmployeeId: f.users.carol.employeeId }),
      book({ occurrenceDates: [day(1)], startTime: "23:15", endTime: "00:15" }),
      book({ occurrenceDates: [day(2)], startTime: "00:10", endTime: "00:50" }),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

    for (const r of results) {
      if (r.status === "rejected") assert.equal((r.reason as { status?: number }).status, 409);
    }

    assert.equal((await liveMeetings()).length, 1);
  });

  it("concurrent bookings cannot slip past a group's daily limit, overnight or not", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    const results = await Promise.allSettled([
      book({ occurrenceDates: [day(1)], startTime: "08:00", endTime: "09:00" }),
      book({ occurrenceDates: [day(1)], startTime: "10:00", endTime: "11:00", organizerEmployeeId: f.users.carol.employeeId }),
      book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00", roomId: f.rooms.beta.room_id }),
      book({ occurrenceDates: [day(1)], startTime: "12:00", endTime: "13:00", roomId: f.rooms.beta.room_id, organizerEmployeeId: f.users.carol.employeeId }),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await liveMeetings()).length, 1);
  });
});

describe("reminders, completion and room lifecycle", () => {
  it("the reminder fires before the START time on the start date", async () => {
    const { meetings } = await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" });

    const [reminder] = await db.select().from(reminder_logs).where(eq(reminder_logs.meeting_id, meetings[0].meeting_id));
    const [y, mo, d, h, mi] = appWallClockToUtc(day(1), "23:00");
    const start = Date.UTC(y, mo - 1, d, h, mi);

    assert.ok(reminder.reminder_time.getTime() < start);
    assert.ok(start - reminder.reminder_time.getTime() <= 60 * 60_000, "within an hour before the start");
    assert.ok(reminder.reminder_time.getTime() > start - 24 * 3600_000);
  });

  const runningOvernight = async () => {
    // Dated today, 00:01 -> 00:00 the next day (23 h 59 min): has not ended at
    // any moment of today. Read the old way (date + end time) it ended at
    // 00:00 today, and would be marked completed.
    const today = dateFromToday(0);

    const [row] = await db
      .insert(meeting)
      .values({
        title: "Running",
        room_id: f.rooms.alpha.room_id,
        meeting_date: today,
        organizerEmployeeId: f.users.bob.employeeId,
        participantCount: 1,
        meetingTypeId: f.types.team,
        meetingStatusId: MEETING_STATUS.SCHEDULED,
        start_time: "00:01",
        end_time: "00:00",
        groupIdAtBooking: f.groupIds.employee,
      })
      .returning();

    return row;
  };

  it("an overnight meeting is not marked completed before its real end", async () => {
    const row = await runningOvernight();

    await updateCompletedMeetings();

    const [after] = await db.select().from(meeting).where(eq(meeting.meeting_id, row.meeting_id));

    assert.equal(after.meetingStatusId, MEETING_STATUS.SCHEDULED);

    // The same slot a day earlier has ended.
    await db.update(meeting).set({ meeting_date: dateFromToday(-3) }).where(eq(meeting.meeting_id, row.meeting_id));
    await updateCompletedMeetings();

    const [done] = await db.select().from(meeting).where(eq(meeting.meeting_id, row.meeting_id));

    assert.equal(done.meetingStatusId, MEETING_STATUS.COMPLETED);
  });

  it("a room cannot be archived while an overnight meeting is still ahead of its end", async () => {
    await runningOvernight();

    const error = await failure(setRoomArchived(f.rooms.alpha.room_id, true));

    assert.equal(error.status, 409);
  });

  it("dashboard hours use the real cross-midnight length", async () => {
    await book({ occurrenceDates: [day(1)], startTime: "23:00", endTime: "01:00" });

    const metrics = await getDashboardMetrics({
      period: { mode: "range", start: day(0), end: day(3), label: "test" },
    });

    assert.equal(metrics.confirmedBookings, 1);
    assert.equal(metrics.totalMeetingHours, 2);
  });
});
