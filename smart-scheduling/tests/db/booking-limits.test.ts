import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { groupAuditLogs, meeting, room } from "@/db/schema";
import { monthOf, weekOf } from "@/lib/booking-limits";
import { addDays } from "@/lib/report-period";
import { nowInAppTimezone } from "@/lib/time";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import { getBookingPolicy } from "@/lib/services/booking-policy.service";
import {
  getAppBookingSettings,
  updateAppBookingSettings,
} from "@/lib/services/booking-settings.service";
import { assignEmployee, GroupError, listGroups, updateGroup } from "@/lib/services/group.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { rescheduleMeeting } from "@/lib/services/reschedule.service";
import { cancelMeetings } from "@/lib/services/series.service";
import type { AppBookingSettingsInput } from "@/lib/validations/booking-settings.validator";
import type { UpdateGroupInput } from "@/lib/validations/group.validator";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";

type GroupSettings = NonNullable<UpdateGroupInput["settings"]>;

let f: Fixtures;
let admin: number;

before(async () => {
  f = await seedFixtures();
  admin = f.users.admin.employeeId;
});

const ALL = ["booking.create", "booking.view", "booking.cancel", "booking.priority", "booking.recurring"];

const APP_OPEN: AppBookingSettingsInput = {
  allowOvernight: false,
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

const setApp = (over: Partial<typeof APP_OPEN> = {}) =>
  updateAppBookingSettings({ ...APP_OPEN, ...over }, admin);

const setGroup = (groupId: number, over: Partial<typeof GROUP_OPEN> = {}) =>
  updateGroup(groupId, { settings: { ...GROUP_OPEN, ...over } }, admin);

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE booking_priority_history, meeting_audit_logs, reminder_logs,
      notifications, reschedule_requests, meeting_attendees, meeting,
      recurring_meetings, group_audit_logs
    RESTART IDENTITY CASCADE
  `);

  await setApp();

  for (const id of Object.values(f.groupIds)) {
    await updateGroup(id, { isActive: true, permissions: ALL, settings: GROUP_OPEN, roomIds: [] }, admin);
  }

  await db.execute(sql`TRUNCATE group_audit_logs RESTART IDENTITY`);
});

const book = (over: Partial<BookingInput> = {}) =>
  createBooking({
    title: "Sync",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [dateFromToday(8)],
    startTime: "10:00",
    endTime: "11:00",
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
    return error as { status?: number; message: string };
  }

  assert.fail("expected the call to be refused");
};

const countMeetings = async () =>
  (await db.select().from(meeting)).filter((m) => m.meetingStatusId !== 3).length;

// A Monday far enough ahead that its whole week is bookable.
const MONDAY = weekOf(dateFromToday(15)).start;
const day = (offset: number) => addDays(MONDAY, offset);

// The first of next month (inside the 3-month booking window).
const NEXT_MONTH = addDays(monthOf(nowInAppTimezone().date).end, 1);

// Two different slots on the same day in the same room, hour after hour.
const slot = (n: number) => ({
  startTime: `${String(8 + n).padStart(2, "0")}:00`,
  endTime: `${String(9 + n).padStart(2, "0")}:00`,
});

describe("daily limit, counted for the whole group", () => {
  it("counts Bob's and Carol's bookings together and refuses the one over the limit", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 3 });

    await book({ occurrenceDates: [day(1)], ...slot(0) });
    await book({ occurrenceDates: [day(1)], ...slot(1), organizerEmployeeId: f.users.carol.employeeId });
    await book({ occurrenceDates: [day(1)], ...slot(2) });

    const error = await failure(book({ occurrenceDates: [day(1)], ...slot(3), organizerEmployeeId: f.users.carol.employeeId }));

    assert.equal(error.status, 400);
    assert.match(error.message, /Your group can book at most 3 bookings per day/);
    assert.equal(await countMeetings(), 3);

    // Another day is still open.
    await book({ occurrenceDates: [day(2)], ...slot(0) });
    assert.equal(await countMeetings(), 4);
  });

  it("another group's bookings do not use this group's allowance", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    await book({ occurrenceDates: [day(1)], ...slot(0) });
    await book({
      occurrenceDates: [day(1)],
      ...slot(1),
      organizerEmployeeId: f.users.manager.employeeId,
      organizerRole: "Manager",
    });

    assert.equal(await countMeetings(), 2);
  });

  it("a cancelled meeting frees its place; rebooking is checked again", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    const { meetings } = await book({ occurrenceDates: [day(1)], ...slot(0) });

    assert.equal((await failure(book({ occurrenceDates: [day(1)], ...slot(1) }))).status, 400);

    await cancelMeetings({
      meetingId: meetings[0].meeting_id,
      scope: "single",
      actor: { employeeId: f.users.bob.employeeId, role: "Employee" },
      notify: false,
    });

    await book({ occurrenceDates: [day(1)], ...slot(1) });
    // The place is taken again.
    assert.equal((await failure(book({ occurrenceDates: [day(1)], ...slot(2) }))).status, 400);
  });

  it("a refused booking writes nothing and uses no allowance", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    await book({ occurrenceDates: [day(1)], ...slot(0) });
    await failure(book({ occurrenceDates: [day(1)], ...slot(1) }));
    await failure(book({ occurrenceDates: [day(1)], ...slot(2) }));

    assert.equal((await db.select().from(meeting)).length, 1);
  });
});

describe("weekly limit (Monday to Sunday) and monthly limit", () => {
  it("counts a calendar week Monday to Sunday", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerWeek: 2 });

    await book({ occurrenceDates: [day(0)], ...slot(0) }); // Monday
    await book({ occurrenceDates: [day(6)], ...slot(0) }); // Sunday, same week

    const error = await failure(book({ occurrenceDates: [day(3)], ...slot(0) }));

    assert.equal(error.status, 400);
    assert.match(error.message, /at most 2 bookings per week \(Monday to Sunday\)/);

    // The next Monday starts a new week; the Sunday before does not.
    await book({ occurrenceDates: [day(7)], ...slot(0) });
    await book({ occurrenceDates: [day(8)], ...slot(0) });
    assert.equal((await failure(book({ occurrenceDates: [day(9)], ...slot(0) }))).status, 400);
  });

  it("counts a calendar month", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerMonth: 2 });

    await book({ occurrenceDates: [NEXT_MONTH], ...slot(0) });
    await book({ occurrenceDates: [addDays(NEXT_MONTH, 10)], ...slot(0) });

    const error = await failure(book({ occurrenceDates: [addDays(NEXT_MONTH, 11)], ...slot(0) }));

    assert.equal(error.status, 400);
    assert.match(error.message, /at most 2 bookings per month/);

    // The month after has its own allowance (when still inside the window).
    const nextNext = addDays(monthOf(NEXT_MONTH).end, 1);

    await book({ occurrenceDates: [nextNext], ...slot(0) });
  });

  it("an unlimited group value never lifts a finite application limit", async () => {
    await setApp({ maxBookingsPerDay: 1 });
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: null });

    await book({ occurrenceDates: [day(1)], ...slot(0) });

    const error = await failure(book({ occurrenceDates: [day(1)], ...slot(1) }));

    assert.match(error.message, /The application allows at most 1 booking per day/);
  });
});

describe("maximum duration: the stricter of application and group", () => {
  it("the application's maximum applies to everyone, with its own message", async () => {
    await setApp({ maxDurationMinutes: 120 });

    await book({ occurrenceDates: [day(1)], startTime: "10:00", endTime: "12:00" });

    const error = await failure(book({ occurrenceDates: [day(1)], startTime: "13:00", endTime: "15:30" }));

    assert.equal(error.status, 400);
    assert.match(error.message, /Meetings can be booked for at most 2 hours/);
  });

  it("a tighter group maximum wins and says it is the group's", async () => {
    await setApp({ maxDurationMinutes: 240 });
    await setGroup(f.groupIds.employee, { maxDurationMinutes: 60 });

    const error = await failure(book({ occurrenceDates: [day(1)], startTime: "10:00", endTime: "11:30" }));

    assert.match(error.message, /Your group can book meetings of at most 1 hour/);
  });

  it("the effective policy is read from the database for the booker's group", async () => {
    await setApp({ allowOvernight: true, maxDurationMinutes: 240, maxBookingsPerDay: 5 });
    await setGroup(f.groupIds.employee, { overnightPolicy: "NOT_ALLOWED", maxBookingsPerDay: 2 });

    const policy = await getBookingPolicy(f.users.bob.employeeId);

    assert.equal(policy.allowOvernight, false);
    assert.equal(policy.maxDurationMinutes, 240);
    assert.equal(policy.maxDurationSource, "application");
    assert.deepEqual(policy.limits.perDay, { value: 2, source: "group" });
    assert.equal((await getBookingPolicy(f.users.manager.employeeId)).allowOvernight, true);
  });
});

describe("rescheduling is not a new booking", () => {
  const bob = { employeeId: 0, role: "Employee" };

  beforeEach(() => {
    bob.employeeId = f.users.bob.employeeId;
  });

  const move = (meetingId: number, meetingDate: string, over: { startTime?: string; endTime?: string } = {}) =>
    rescheduleMeeting({
      meetingId,
      actor: bob,
      roomId: f.rooms.alpha.room_id,
      meetingDate,
      startTime: over.startTime ?? "14:00",
      endTime: over.endTime ?? "15:00",
      notify: false,
    });

  it("moving inside a full day, and a full week, is allowed and changes no count", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 2, maxBookingsPerWeek: 3 });

    const a = await book({ occurrenceDates: [day(1)], ...slot(0) });
    await book({ occurrenceDates: [day(1)], ...slot(1) });
    await book({ occurrenceDates: [day(2)], ...slot(0) });

    // The day (2/2) and the week (3/3) are full: a new booking is refused...
    assert.equal((await failure(book({ occurrenceDates: [day(1)], ...slot(5) }))).status, 400);

    // ...but moving a meeting inside them is not a new booking.
    await move(a.meetings[0].meeting_id, day(1), { startTime: "16:00", endTime: "17:00" });

    assert.equal(await countMeetings(), 3);
  });

  it("moving to another day is checked against that day and its week, without double counting itself", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    const a = await book({ occurrenceDates: [day(1)], ...slot(0) });
    await book({ occurrenceDates: [day(2)], ...slot(0) });

    const error = await failure(move(a.meetings[0].meeting_id, day(2)));

    assert.equal(error.status, 400);
    assert.match(error.message, /per day/);

    // An empty day is fine, and the meeting still counts once.
    await move(a.meetings[0].meeting_id, day(3));
    assert.equal(await countMeetings(), 2);

    // Its old day is free again.
    await book({ occurrenceDates: [day(1)], ...slot(0) });
  });

  it("moving into a week that is already full is refused; the meeting stays where it was", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerWeek: 1 });

    const a = await book({ occurrenceDates: [day(1)], ...slot(0) });
    await book({ occurrenceDates: [day(8)], ...slot(0) });

    const error = await failure(move(a.meetings[0].meeting_id, day(9)));

    assert.match(error.message, /per week/);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, a.meetings[0].meeting_id));

    assert.equal(row.meeting_date, day(1));
  });

  it("a group already over a lowered limit can still move its meetings within the period", async () => {
    const a = await book({ occurrenceDates: [day(1)], ...slot(0) });
    await book({ occurrenceDates: [day(1)], ...slot(1) });
    await book({ occurrenceDates: [day(1)], ...slot(2) });

    // Lowered after the fact: three meetings now sit on a one-a-day group's day.
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    await move(a.meetings[0].meeting_id, day(1), { startTime: "18:00", endTime: "19:00" });

    assert.equal(await countMeetings(), 3);
  });

  it("a meeting keeps counting for the group it was booked under when its organizer changes group", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 1 });

    const a = await book({ occurrenceDates: [day(1)], ...slot(0) });
    await book({ occurrenceDates: [day(2)], ...slot(0), organizerEmployeeId: f.users.carol.employeeId });

    // Bob moves to the Manager group (no limits); the meeting was booked under
    // Employee, so Employee's allowance still decides where it may go.
    await assignEmployee(f.users.bob.employeeId, f.groupIds.manager, admin);

    try {
      const error = await failure(move(a.meetings[0].meeting_id, day(2)));

      assert.match(error.message, /per day/);
      assert.equal((await db.select().from(meeting).where(eq(meeting.meeting_id, a.meetings[0].meeting_id)))[0].groupIdAtBooking, f.groupIds.employee);
    } finally {
      // Back in the Employee group for the tests that follow.
      await assignEmployee(f.users.bob.employeeId, f.groupIds.employee, admin);
    }
  });
});

describe("recurring series", () => {
  const series = (count: number, start: string, over: Record<string, unknown> = {}) =>
    createRecurringMeeting({
      title: "Series",
      room_id: f.rooms.alpha.room_id,
      meeting_date: start,
      start_time: "10:00",
      end_time: "11:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 1,
      meetingTypeId: f.types.team,
      frequency_id: 2, // weekly
      occurrence_count: count,
      notify: false,
      ...over,
    });

  it("is refused as a whole when its occurrences overflow the monthly limit; nothing is created", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerMonth: 3 });

    // Weekly occurrences starting on the 1st of next month: five fall in it.
    const error = await failure(series(5, NEXT_MONTH));

    assert.equal(error.status, 400);
    assert.match(error.message, /per month/);
    assert.match(error.message, /Occurrence on/);
    assert.equal((await db.select().from(meeting)).length, 0);
  });

  it("counts the series' occurrences together with existing bookings", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerMonth: 4 });

    await book({ occurrenceDates: [addDays(NEXT_MONTH, 2)], ...slot(0) });

    // 3 more weekly occurrences fit (4 in total); 4 do not.
    assert.equal((await series(3, NEXT_MONTH)).meetings.length, 3);
    assert.equal((await failure(series(2, addDays(NEXT_MONTH, 1), { start_time: "12:00", end_time: "13:00" }))).status, 400);
    assert.equal(await countMeetings(), 4);
  });

  it("is accepted when every occurrence is within the limits", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerWeek: 1, maxBookingsPerMonth: 5 });

    assert.equal((await series(4, day(1))).meetings.length, 4);
  });
});

describe("concurrent bookings", () => {
  it("cannot take more places than the group has, even across different rooms", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 3 });

    // Different rooms do not share a room lock: only the group lock keeps the
    // count honest.
    const extra = await db
      .insert(room)
      .values(
        [1, 2, 3, 4, 5].map((n) => ({
          room_name: `Concurrent ${n}`,
          room_capacity: 10,
          roomLocation: "Floor 9",
          availabilityStatusId: 1,
        }))
      )
      .returning();

    const attempts = await Promise.allSettled(
      extra.map((r, i) =>
        book({
          roomId: r.room_id,
          occurrenceDates: [day(1)],
          organizerEmployeeId: i % 2 === 0 ? f.users.bob.employeeId : f.users.carol.employeeId,
        })
      )
    );

    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 3);

    for (const refused of attempts.filter((a) => a.status === "rejected")) {
      assert.match(String((refused as PromiseRejectedResult).reason?.message), /per day/);
    }

    assert.equal(await countMeetings(), 3);
  });
});

describe("changing policies never touches existing meetings or groups", () => {
  it("lowering the application limit leaves meetings and group settings alone; only new bookings follow it", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 5, maxDurationMinutes: 240 });

    for (let n = 0; n < 4; n++) {
      await book({ occurrenceDates: [day(1)], ...slot(n) });
    }

    const before = await db.select().from(meeting);

    const result = await setApp({ maxBookingsPerDay: 2, maxDurationMinutes: 60 });

    assert.deepEqual(result.groupsAboveLimits, ["Employee"]);
    assert.deepEqual(await db.select().from(meeting), before);

    const employee = (await listGroups()).find((g) => g.id === f.groupIds.employee)!;

    assert.equal(employee.settings.maxBookingsPerDay, 5);
    assert.equal(employee.settings.maxDurationMinutes, 240);

    // New bookings follow the stricter application values.
    assert.equal((await failure(book({ occurrenceDates: [day(1)], ...slot(6) }))).status, 400);
    assert.equal((await failure(book({ occurrenceDates: [day(3)], startTime: "10:00", endTime: "12:00" }))).status, 400);
    await book({ occurrenceDates: [day(3)], ...slot(0) });
  });
});

describe("authorization and validation of the settings", () => {
  it("only someone who can manage groups can change the application policies", async () => {
    const error = await failure(updateAppBookingSettings({ ...APP_OPEN, maxBookingsPerDay: 1 }, f.users.bob.employeeId));

    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 403);
    assert.equal((await getAppBookingSettings()).maxBookingsPerDay, null);
  });

  it("only someone who can manage groups can change a group's overnight choice or day/week/month limits", async () => {
    for (const settings of [
      { ...GROUP_OPEN, overnightPolicy: "NOT_ALLOWED" as const },
      { ...GROUP_OPEN, maxBookingsPerDay: 2 },
      { ...GROUP_OPEN, maxBookingsPerWeek: 2 },
      { ...GROUP_OPEN, maxBookingsPerMonth: 2 },
    ]) {
      const error = await failure(updateGroup(f.groupIds.employee, { settings }, f.users.bob.employeeId));

      assert.equal(error.status, 403);
      assert.match(error.message, /permission.*booking policies/);
    }
  });

  it("a member of a group that grants group.manage (e.g. the Admin group) may change both", async () => {
    // Bob's group is given Group Management access (what the Admin group has).
    await updateGroup(f.groupIds.employee, { permissions: [...ALL, "group.manage"] }, admin);

    try {
      await updateAppBookingSettings({ ...APP_OPEN, maxBookingsPerDay: 6 }, f.users.bob.employeeId);
      await updateGroup(
        f.groupIds.employee,
        { settings: { ...GROUP_OPEN, maxBookingsPerDay: 2, overnightPolicy: "NOT_ALLOWED" } },
        f.users.bob.employeeId
      );

      const settings = (await listGroups()).find((g) => g.id === f.groupIds.employee)!.settings;

      assert.equal(settings.maxBookingsPerDay, 2);
      assert.equal(settings.overnightPolicy, "NOT_ALLOWED");
      assert.equal((await getAppBookingSettings()).maxBookingsPerDay, 6);

      // ...and the audit trail names them.
      const rows = await db.select().from(groupAuditLogs).where(eq(groupAuditLogs.action, "APP_BOOKING_POLICY_CHANGED"));

      assert.equal(rows[0].actorEmployeeId, f.users.bob.employeeId);

      // The group now holds an administrative permission, so everything else
      // about it still belongs to administrators.
      const bob = f.users.bob.employeeId;

      for (const change of [
        { name: "Renamed" },
        { isActive: false },
        { permissions: ALL },
        { roomIds: [f.rooms.alpha.room_id] },
      ]) {
        const error = await failure(updateGroup(f.groupIds.employee, change, bob));

        assert.equal(error.status, 403, JSON.stringify(change));
      }

      // Sending the whole form back unchanged, with a new limit, is accepted.
      await updateGroup(
        f.groupIds.employee,
        {
          name: "Employee",
          permissions: [...ALL, "group.manage"],
          roomIds: [],
          settings: { ...GROUP_OPEN, maxBookingsPerDay: 3 },
        },
        bob
      );
    } finally {
      await updateGroup(f.groupIds.employee, { permissions: ALL }, admin);
    }

    // Without it, the same calls are refused again.
    assert.equal((await failure(updateAppBookingSettings(APP_OPEN, f.users.bob.employeeId))).status, 403);
  });

  it("a group cannot exceed the application limits or allow what the application forbids", async () => {
    await setApp({ allowOvernight: false, maxDurationMinutes: 240, maxBookingsPerDay: 3, maxBookingsPerWeek: 10, maxBookingsPerMonth: 30 });

    const refused: [Partial<typeof GROUP_OPEN>, RegExp][] = [
      [{ overnightPolicy: "ALLOWED" }, /turned off for the whole application/],
      [{ maxDurationMinutes: 300 }, /Maximum meeting duration.*240/],
      [{ maxBookingsPerDay: 4 }, /per day.*3/],
      [{ maxBookingsPerWeek: 11 }, /per week.*10/],
      [{ maxBookingsPerMonth: 31 }, /per month.*30/],
    ];

    for (const [over, message] of refused) {
      const error = await failure(setGroup(f.groupIds.employee, over));

      assert.equal(error.status, 400);
      assert.match(error.message, message);
    }

    // At or below the application's value, and "not allowed", are fine.
    await setGroup(f.groupIds.employee, { maxDurationMinutes: 240, maxBookingsPerDay: 3, overnightPolicy: "NOT_ALLOWED" });
  });

  it("an unrelated edit is not blocked by a stored value the application lowered later", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 5 });
    await setApp({ maxBookingsPerDay: 2 });

    // Same settings sent back with a new description: nothing changed, so
    // nothing is re-validated or rewritten.
    await updateGroup(f.groupIds.employee, { description: "Renamed", settings: { ...GROUP_OPEN, maxBookingsPerDay: 5 } }, admin);

    assert.equal((await listGroups()).find((g) => g.id === f.groupIds.employee)!.settings.maxBookingsPerDay, 5);
  });

  it("a client that does not send the new fields never resets them", async () => {
    await setGroup(f.groupIds.employee, { maxBookingsPerDay: 2, overnightPolicy: "NOT_ALLOWED" });

    await updateGroup(
      f.groupIds.employee,
      { settings: { maxDurationMinutes: 90, maxAdvanceDays: null, maxOccurrences: null } },
      admin
    );

    const settings = (await listGroups()).find((g) => g.id === f.groupIds.employee)!.settings;

    assert.equal(settings.maxDurationMinutes, 90);
    assert.equal(settings.maxBookingsPerDay, 2);
    assert.equal(settings.overnightPolicy, "NOT_ALLOWED");
  });

  it("the database rejects nonsense values", async () => {
    // The driver wraps the Postgres error; the constraint is on its cause.
    const constraintOf = async (statement: Promise<unknown>) => {
      try {
        await statement;
      } catch (error) {
        return (error as { cause?: { constraint?: string } }).cause?.constraint;
      }

      return undefined;
    };

    assert.equal(
      await constraintOf(db.execute(sql`UPDATE group_settings SET overnight_policy = 'SOMETIMES' WHERE group_id = ${f.groupIds.employee}`)),
      "group_settings_overnight_valid"
    );
    assert.equal(
      await constraintOf(db.execute(sql`UPDATE group_settings SET max_bookings_per_day = 0 WHERE group_id = ${f.groupIds.employee}`)),
      "group_settings_per_day_range"
    );
    assert.equal(
      await constraintOf(db.execute(sql`INSERT INTO app_booking_settings (id) VALUES (2)`)),
      "app_booking_settings_single_row"
    );
  });
});

describe("audit trail", () => {
  it("records application policy changes with the actor and the previous and new values", async () => {
    await setApp({ maxBookingsPerDay: 4, allowOvernight: true });
    await setApp({ maxBookingsPerDay: 4, allowOvernight: true }); // no change: no entry

    const rows = await db.select().from(groupAuditLogs).where(eq(groupAuditLogs.action, "APP_BOOKING_POLICY_CHANGED"));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].actorEmployeeId, admin);
    assert.deepEqual((rows[0].details as { before: unknown }).before, APP_OPEN);
    assert.deepEqual((rows[0].details as { after: unknown }).after, { ...APP_OPEN, maxBookingsPerDay: 4, allowOvernight: true });
  });

  it("records group policy changes with the group, the actor and before/after", async () => {
    await setApp({ allowOvernight: true });
    await setGroup(f.groupIds.employee, { overnightPolicy: "NOT_ALLOWED", maxBookingsPerWeek: 7 });

    const [row] = await db.select().from(groupAuditLogs).where(eq(groupAuditLogs.action, "GROUP_BOOKING_POLICY_CHANGED"));

    assert.equal(row.groupId, f.groupIds.employee);
    assert.equal(row.actorEmployeeId, admin);

    const details = row.details as { before: Record<string, unknown>; after: Record<string, unknown> };

    assert.equal(details.before.overnight, "INHERIT");
    assert.equal(details.after.overnight, "NOT_ALLOWED");
    assert.equal(details.before.maxBookingsPerWeek, null);
    assert.equal(details.after.maxBookingsPerWeek, 7);
  });

  it("an edit that changes no booking policy writes no policy entry", async () => {
    await setGroup(f.groupIds.employee, {});

    const rows = await db.select().from(groupAuditLogs).where(eq(groupAuditLogs.action, "GROUP_BOOKING_POLICY_CHANGED"));

    assert.equal(rows.length, 0);
  });
});
