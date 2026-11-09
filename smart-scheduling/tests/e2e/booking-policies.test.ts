import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { groupAuditLogs, meeting } from "@/db/schema";
import { monthOf, weekOf } from "@/lib/booking-limits";
import { addDays } from "@/lib/report-period";
import { nowInAppTimezone } from "@/lib/time";
import { updateAppBookingSettings } from "@/lib/services/booking-settings.service";
import { updateGroup } from "@/lib/services/group.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { startApp, type App } from "./harness";

// The booking policies over HTTP, as the application really serves them:
// Admin-only configuration, the same-day rules, the group's day / week / month
// allowance, the longest meeting, rescheduling, recurring series, and policy
// changes that leave existing meetings alone.
//
// Overnight booking (a meeting that continues past midnight) is covered in
// tests/e2e/overnight.test.ts; here only the refusal while the policy is off.

let app: App;
let f: Fixtures;
let admin: number;

const ALL = ["booking.create", "booking.view", "booking.cancel", "booking.priority", "booking.recurring"];

const APP_OPEN = {
  allowOvernight: false,
  maxDurationMinutes: null,
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

const GROUP_OPEN = {
  maxDurationMinutes: null,
  maxAdvanceDays: null,
  maxOccurrences: null,
  overnightPolicy: "INHERIT",
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

before(async () => {
  f = await seedFixtures();
  admin = f.users.admin.employeeId;
  app = await startApp(3204);
});

after(() => app?.stop());

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE meeting_audit_logs, reminder_logs, notifications, meeting_attendees, meeting,
      recurring_meetings, group_audit_logs
    RESTART IDENTITY CASCADE
  `);

  await updateAppBookingSettings(APP_OPEN, admin);

  for (const id of Object.values(f.groupIds)) {
    await updateGroup(
      id,
      { isActive: true, permissions: ALL, settings: GROUP_OPEN as never, roomIds: [] },
      admin
    );
  }
});

const MONDAY = weekOf(dateFromToday(15)).start;
const day = (n: number) => addDays(MONDAY, n);
const NEXT_MONTH = addDays(monthOf(nowInAppTimezone().date).end, 1);

const slot = (n: number) => ({
  start_time: `${String(8 + n).padStart(2, "0")}:00`,
  end_time: `${String(9 + n).padStart(2, "0")}:00`,
});

const book = (user: { email: string }, date: string, over: Record<string, unknown> = {}) =>
  app.call("POST", "/api/meetings/booking", {
    as: user,
    body: {
      title: "Planning",
      meeting_date: date,
      room_id: f.rooms.alpha.room_id,
      participant_count: 1,
      meeting_type_id: f.types.team,
      ...slot(0),
      ...over,
    },
  });

const message = (res: { json?: Record<string, unknown> | null; text: string }) =>
  String(res.json?.message ?? res.text);

const putApp = (user: { email: string }, body: unknown) =>
  app.call("PUT", "/api/admin/booking-settings", { as: user, body });

const patchGroup = (user: { email: string }, id: number, settings: Record<string, unknown>) =>
  app.call("PATCH", `/api/admin/groups/${id}`, {
    as: user,
    body: { settings: { ...GROUP_OPEN, ...settings } },
  });

const meetingCount = async () => (await db.select().from(meeting)).length;

describe("1. an administrator changes the application policies", () => {
  it("reads and saves them; everyone else, and anonymous callers, are refused", async () => {
    const saved = await putApp(f.users.admin, {
      allowOvernight: true,
      maxDurationMinutes: 240,
      maxBookingsPerDay: 5,
      maxBookingsPerWeek: 20,
      maxBookingsPerMonth: 60,
    });

    assert.equal(saved.status, 200, saved.text);
    assert.equal((saved.json!.settings as { maxDurationMinutes: number }).maxDurationMinutes, 240);

    const read = await app.call("GET", "/api/admin/booking-settings", { as: f.users.admin });

    assert.equal(read.status, 200);
    assert.equal((read.json!.settings as { allowOvernight: boolean }).allowOvernight, true);

    for (const user of [f.users.bob, f.users.manager]) {
      assert.equal((await putApp(user, APP_OPEN)).status, 403);
      assert.equal((await app.call("GET", "/api/admin/booking-settings", { as: user })).status, 403);
    }

    assert.equal((await app.call("GET", "/api/admin/booking-settings")).status, 401);
    assert.equal((await app.call("PUT", "/api/admin/booking-settings", { body: APP_OPEN })).status, 401);

    // Nothing changed by the refused calls.
    const after = await app.call("GET", "/api/admin/booking-settings", { as: f.users.admin });

    assert.equal((after.json!.settings as { maxBookingsPerDay: number }).maxBookingsPerDay, 5);
  });

  it("rejects nonsense: wrong types, out-of-range values", async () => {
    for (const body of [
      { ...APP_OPEN, maxDurationMinutes: 5 },
      { ...APP_OPEN, maxDurationMinutes: 99999 },
      { ...APP_OPEN, maxBookingsPerDay: 0 },
      { ...APP_OPEN, maxBookingsPerWeek: 1.5 },
      { ...APP_OPEN, allowOvernight: "yes" },
      { maxBookingsPerDay: 3 },
    ]) {
      assert.equal((await putApp(f.users.admin, body)).status, 400, JSON.stringify(body));
    }
  });

  it("writes an audit entry with the actor and the previous and new values", async () => {
    await putApp(f.users.admin, { ...APP_OPEN, maxBookingsPerDay: 4 });

    const [row] = await db.select().from(groupAuditLogs).where(eq(groupAuditLogs.action, "APP_BOOKING_POLICY_CHANGED"));

    assert.equal(row.actorEmployeeId, admin);
    assert.equal((row.details as { before: { maxBookingsPerDay: number | null } }).before.maxBookingsPerDay, null);
    assert.equal((row.details as { after: { maxBookingsPerDay: number } }).after.maxBookingsPerDay, 4);
  });

  it("the admin page offers the policies to an administrator", async () => {
    const page = await app.call("GET", "/admin/groups", { as: f.users.admin });

    assert.equal(page.status, 200);
    assert.match(page.text, /Application booking policies/);
  });
});

describe("2. two groups with different policies", () => {
  it("each group is held to its own limits; the booking form is told the effective ones", async () => {
    assert.equal((await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerDay: 1, maxDurationMinutes: 60 })).status, 200);
    assert.equal((await patchGroup(f.users.admin, f.groupIds.manager, { maxBookingsPerDay: 3, maxDurationMinutes: 180 })).status, 200);

    const bob = await app.call("GET", "/api/booking-policy", { as: f.users.bob });
    const manager = await app.call("GET", "/api/booking-policy", { as: f.users.manager });

    assert.deepEqual(
      [bob.json!.policy, manager.json!.policy].map((p) => {
        const policy = p as { maxBookingsPerDay: number; maxDurationMinutes: number; allowOvernight: boolean };

        return [policy.maxBookingsPerDay, policy.maxDurationMinutes, policy.allowOvernight];
      }),
      [[1, 60, false], [3, 180, false]]
    );

    // Bob (Employee group): one a day, an hour at most.
    assert.equal((await book(f.users.bob, day(1))).status, 201);
    assert.equal((await book(f.users.bob, day(1), slot(1))).status, 400);
    assert.equal((await book(f.users.bob, day(2), { start_time: "10:00", end_time: "11:30" })).status, 400);

    // The Manager is under the Manager group's policy.
    assert.equal((await book(f.users.manager, day(1), { start_time: "13:00", end_time: "16:00" })).status, 201);
  });

  it("only an administrator can set a group's booking policies", async () => {
    for (const settings of [{ maxBookingsPerDay: 1 }, { overnightPolicy: "NOT_ALLOWED" }, { maxBookingsPerWeek: 1 }]) {
      const res = await patchGroup(f.users.bob, f.groupIds.employee, settings);

      assert.ok([401, 403].includes(res.status), `${res.status} ${res.text}`);
    }

    assert.equal((await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerDay: 1 })).status, 200);
  });

  it("a group cannot exceed the application's limits or allow overnight while it is off", async () => {
    await putApp(f.users.admin, { ...APP_OPEN, maxBookingsPerDay: 2, maxDurationMinutes: 120 });

    for (const settings of [{ maxBookingsPerDay: 3 }, { maxDurationMinutes: 180 }, { overnightPolicy: "ALLOWED" }]) {
      const res = await patchGroup(f.users.admin, f.groupIds.employee, settings);

      assert.equal(res.status, 400, JSON.stringify(settings));
    }
  });
});

describe("3. same-day bookings and overnight", () => {
  it("a same-day meeting books normally", async () => {
    const res = await book(f.users.bob, day(1), { start_time: "09:00", end_time: "10:00" });

    assert.equal(res.status, 201, res.text);
    assert.equal(await meetingCount(), 1);
  });

  it("a meeting that ends the next day is refused while overnight is off, and the form says it is not permitted", async () => {
    const res = await book(f.users.bob, day(1), { start_time: "23:00", end_time: "01:00" });

    assert.equal(res.status, 403);
    assert.match(message(res), /Overnight bookings are not permitted/);

    const policy = await app.call("GET", "/api/booking-policy", { as: f.users.bob });

    assert.equal((policy.json!.policy as { allowOvernight: boolean }).allowOvernight, false);
  });
});

describe("4. day, week and month limits over HTTP", () => {
  it("daily: the booking over the limit is refused with the policy named", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerDay: 2 });

    assert.equal((await book(f.users.bob, day(1), slot(0))).status, 201);
    assert.equal((await book(f.users.carol, day(1), slot(1))).status, 201);

    const refused = await book(f.users.bob, day(1), slot(2));

    assert.equal(refused.status, 400);
    assert.match(message(refused), /Your group can book at most 2 bookings per day/);
    assert.equal(await meetingCount(), 2);
  });

  it("weekly: Monday to Sunday", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerWeek: 2 });

    assert.equal((await book(f.users.bob, day(0))).status, 201);
    assert.equal((await book(f.users.bob, day(6))).status, 201);

    const refused = await book(f.users.carol, day(3));

    assert.equal(refused.status, 400);
    assert.match(message(refused), /per week \(Monday to Sunday\)/);
    assert.equal((await book(f.users.carol, day(7))).status, 201);
  });

  it("monthly: calendar month", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerMonth: 2 });

    assert.equal((await book(f.users.bob, NEXT_MONTH)).status, 201);
    assert.equal((await book(f.users.bob, addDays(NEXT_MONTH, 9))).status, 201);

    const refused = await book(f.users.carol, addDays(NEXT_MONTH, 10));

    assert.equal(refused.status, 400);
    assert.match(message(refused), /per month/);
  });

  it("cancelling a meeting releases its place", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerDay: 1 });

    const first = await book(f.users.bob, day(1), slot(0));
    const id = (first.json as { meeting?: { meeting_id: number }; meetings?: { meeting_id: number }[] }).meeting?.meeting_id
      ?? (await db.select().from(meeting))[0].meeting_id;

    assert.equal((await book(f.users.bob, day(1), slot(1))).status, 400);
    assert.equal((await app.call("PATCH", `/api/meetings/cancel/${id}`, { as: f.users.bob })).status, 200);
    assert.equal((await book(f.users.bob, day(1), slot(1))).status, 201);
  });
});

describe("5. the longest meeting", () => {
  it("the application maximum applies to everyone; a tighter group maximum wins", async () => {
    await putApp(f.users.admin, { ...APP_OPEN, maxDurationMinutes: 180 });

    assert.equal((await book(f.users.bob, day(1), { start_time: "09:00", end_time: "12:00" })).status, 201);

    const refused = await book(f.users.bob, day(2), { start_time: "09:00", end_time: "12:30" });

    assert.equal(refused.status, 400);
    assert.match(message(refused), /Meetings can be booked for at most 3 hours/);

    await patchGroup(f.users.admin, f.groupIds.employee, { maxDurationMinutes: 60 });

    const group = await book(f.users.bob, day(3), { start_time: "09:00", end_time: "10:30" });

    assert.equal(group.status, 400);
    assert.match(message(group), /Your group can book meetings of at most 1 hour/);
  });
});

describe("6. rescheduling", () => {
  it("moving does not consume allowance; moving into a full day is refused", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerDay: 1 });

    assert.equal((await book(f.users.bob, day(1), slot(0))).status, 201);
    assert.equal((await book(f.users.bob, day(2), slot(0))).status, 201);

    const [a, b] = (await db.select().from(meeting)).sort((x, y) => x.meeting_id - y.meeting_id);

    // Same day, other hour: fine even though the day is "full".
    const inside = await app.call("PATCH", `/api/meetings/reschedule/${a.meeting_id}`, {
      as: f.users.bob,
      body: { room_id: f.rooms.alpha.room_id, meeting_date: day(1), start_time: "15:00", end_time: "16:00" },
    });

    assert.equal(inside.status, 200, inside.text);

    // Onto the other meeting's full day: refused, and nothing moves.
    const refused = await app.call("PATCH", `/api/meetings/reschedule/${a.meeting_id}`, {
      as: f.users.bob,
      body: { room_id: f.rooms.alpha.room_id, meeting_date: day(2), start_time: "15:00", end_time: "16:00" },
    });

    assert.equal(refused.status, 400);
    assert.match(message(refused), /per day/);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, a.meeting_id));

    assert.equal(row.meeting_date, day(1));
    assert.ok(b);
  });
});

describe("7. recurring series", () => {
  const series = (user: { email: string }, over: Record<string, unknown> = {}) =>
    app.call("POST", "/api/meetings/recurring", {
      as: user,
      body: {
        title: "Weekly sync",
        room_id: f.rooms.alpha.room_id,
        meeting_date: NEXT_MONTH,
        start_time: "10:00",
        end_time: "11:00",
        participantCount: 1,
        meetingTypeId: f.types.team,
        frequency_id: 2,
        occurrence_count: 4,
        ...over,
      },
    });

  it("is refused whole when an occurrence overflows a limit; nothing is created", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerMonth: 3 });

    const refused = await series(f.users.bob);

    assert.equal(refused.status, 400);
    assert.match(message(refused), /per month/);
    assert.match(message(refused), /Occurrence on/);
    assert.equal(await meetingCount(), 0);
  });

  it("is accepted when every occurrence is within the limits", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerWeek: 1, maxBookingsPerMonth: 4 });

    const ok = await series(f.users.bob);

    assert.equal(ok.status, 201, ok.text);
    assert.equal(await meetingCount(), 4);
  });
});

describe("8. policies change while existing meetings stay intact", () => {
  it("lowering limits leaves meetings and group values alone; new bookings follow the latest policy", async () => {
    await patchGroup(f.users.admin, f.groupIds.employee, { maxBookingsPerDay: 4, maxDurationMinutes: 240 });

    for (let n = 0; n < 3; n++) {
      assert.equal((await book(f.users.bob, day(1), slot(n))).status, 201);
    }

    const before = await db.select().from(meeting);

    const lowered = await putApp(f.users.admin, { ...APP_OPEN, maxBookingsPerDay: 1, maxDurationMinutes: 60 });

    assert.equal(lowered.status, 200);
    assert.deepEqual((lowered.json!.settings as { groupsAboveLimits: string[] }).groupsAboveLimits, ["Employee"]);
    assert.deepEqual(await db.select().from(meeting), before);

    const groups = await app.call("GET", "/api/admin/groups", { as: f.users.admin });
    const employee = (groups.json!.groups as { id: number; settings: { maxBookingsPerDay: number } }[]).find((g) => g.id === f.groupIds.employee)!;

    assert.equal(employee.settings.maxBookingsPerDay, 4);

    // New bookings follow the stricter application values; an existing meeting can still be moved inside its day.
    assert.equal((await book(f.users.bob, day(1), slot(5))).status, 400);
    assert.equal((await book(f.users.bob, day(3), { start_time: "09:00", end_time: "10:30" })).status, 400);
    assert.equal((await book(f.users.bob, day(3), slot(0))).status, 201);

    const first = before.sort((x, y) => x.meeting_id - y.meeting_id)[0];
    const moved = await app.call("PATCH", `/api/meetings/reschedule/${first.meeting_id}`, {
      as: f.users.bob,
      body: { room_id: f.rooms.alpha.room_id, meeting_date: day(1), start_time: "17:00", end_time: "18:00" },
    });

    assert.equal(moved.status, 200, moved.text);
  });
});
