import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  entraSyncSettings,
  employeeSyncRuns,
  groupAuditLogs,
  userGroups,
} from "@/db/schema";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import { getBookingPolicy } from "@/lib/services/booking-policy.service";
import { runScheduledSync, syncEmployees } from "@/lib/services/entra-sync.service";
import {
  getEntraSettings,
  updateEntraSettings,
} from "@/lib/services/entra-settings.service";
import { canManageRooms } from "@/lib/services/group-context.service";
import { GroupError, listGroups, updateGroup } from "@/lib/services/group.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";

let f: Fixtures;
let admin: number;

before(async () => {
  f = await seedFixtures();
  admin = f.users.admin.employeeId;
});

const ALL = ["booking.create", "booking.view", "booking.cancel", "booking.priority", "booking.recurring"];

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE booking_priority_history, meeting_audit_logs, reminder_logs,
      notifications, reschedule_requests, meeting_attendees, meeting,
      recurring_meetings
    RESTART IDENTITY CASCADE
  `);

  // The Employee group (Bob and Carol) back to: everything allowed, no limits.
  await updateGroup(
    f.groupIds.employee,
    {
      isActive: true,
      permissions: ALL,
      settings: { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: null },
      roomIds: [],
    },
    admin
  );
});

function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Sync",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [dateFromToday(7)],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 1,
    meetingTypeId: f.types.team,
    notify: false,
    ...overrides,
  };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string };
  }

  assert.fail("expected the call to be rejected");
};

describe("room access per group", () => {
  it("a group with no list may book every room; with a list, only those", async () => {
    await createBooking(input({ roomId: f.rooms.beta.room_id }));

    await updateGroup(f.groupIds.employee, { roomIds: [f.rooms.alpha.room_id] }, admin);

    await createBooking(input({ startTime: "12:00", endTime: "13:00" }));

    const denied = await failure(createBooking(input({ roomId: f.rooms.beta.room_id, startTime: "14:00", endTime: "15:00" })));

    assert.equal(denied.status, 403);
    assert.match(denied.message, /not allowed to book this room/);

    // Other groups are unaffected.
    await createBooking(
      input({ organizerEmployeeId: f.users.manager.employeeId, organizerRole: "Manager", roomId: f.rooms.beta.room_id, startTime: "16:00", endTime: "17:00" })
    );
  });

  it("is saved with the group, listed back, and unknown rooms are rejected", async () => {
    await updateGroup(f.groupIds.employee, { roomIds: [f.rooms.beta.room_id] }, admin);

    assert.deepEqual((await listGroups()).find((g) => g.id === f.groupIds.employee)!.roomIds, [f.rooms.beta.room_id]);

    const error = await failure(updateGroup(f.groupIds.employee, { roomIds: [99999] }, admin));

    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 400);
    assert.deepEqual(
      (await listGroups()).find((g) => g.id === f.groupIds.employee)!.roomIds,
      [f.rooms.beta.room_id],
      "a rejected save changes nothing"
    );
  });

  it("people with no group, or an inactive group, may book every room", async () => {
    await updateGroup(f.groupIds.employee, { roomIds: [f.rooms.beta.room_id] }, admin);
    await updateGroup(f.groupIds.employee, { isActive: false }, admin);

    assert.equal((await getBookingPolicy(f.users.bob.employeeId)).roomIds, null);
    assert.equal((await getBookingPolicy(f.users.dave.employeeId)).roomIds, null);
  });
});

describe("booking limits per group", () => {
  it("longest meeting", async () => {
    await updateGroup(f.groupIds.employee, { settings: { maxDurationMinutes: 60, maxAdvanceDays: null, maxOccurrences: null } }, admin);

    await createBooking(input());

    const error = await failure(createBooking(input({ startTime: "12:00", endTime: "13:30" })));

    assert.equal(error.status, 400);
    assert.match(error.message, /at most 1 hour/);
  });

  it("days ahead", async () => {
    await updateGroup(f.groupIds.employee, { settings: { maxDurationMinutes: null, maxAdvanceDays: 10, maxOccurrences: null } }, admin);

    await createBooking(input({ occurrenceDates: [dateFromToday(10)] }));

    const error = await failure(createBooking(input({ occurrenceDates: [dateFromToday(11)], startTime: "12:00", endTime: "13:00" })));

    assert.equal(error.status, 400);
    assert.match(error.message, /10 days ahead/);
  });

  it("occurrences in a series", async () => {
    await updateGroup(f.groupIds.employee, { settings: { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: 2 } }, admin);

    const series = (count: number, start: string) =>
      createRecurringMeeting({
        title: "Series",
        room_id: f.rooms.alpha.room_id,
        meeting_date: dateFromToday(8),
        start_time: start,
        end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:00`,
        organizerEmployeeId: f.users.bob.employeeId,
        organizerRole: "Employee",
        participantCount: 1,
        meetingTypeId: f.types.team,
        frequency_id: 2,
        occurrence_count: count,
        notify: false,
      });

    assert.equal((await series(2, "09:00")).meetings.length, 2);

    const error = await failure(series(3, "11:00"));

    assert.equal(error.status, 400);
    assert.match(error.message, /at most 2 occurrences/);
  });

  it("limits are re-read on every booking, so a change applies at once", async () => {
    await createBooking(input({ endTime: "13:00" }));

    await updateGroup(f.groupIds.employee, { settings: { maxDurationMinutes: 30, maxAdvanceDays: null, maxOccurrences: null } }, admin);

    assert.equal((await failure(createBooking(input({ startTime: "14:00", endTime: "15:00" })))).status, 400);

    const saved = (await listGroups()).find((g) => g.id === f.groupIds.employee)!;

    assert.equal(saved.settings.maxDurationMinutes, 30);
  });
});

describe("recurring meetings permission", () => {
  const series = () =>
    createRecurringMeeting({
      title: "Series",
      room_id: f.rooms.alpha.room_id,
      meeting_date: dateFromToday(9),
      start_time: "10:00",
      end_time: "11:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 1,
      meetingTypeId: f.types.team,
      frequency_id: 2,
      occurrence_count: 2,
      notify: false,
    });

  it("a group without it cannot book a series but can still book single meetings", async () => {
    await updateGroup(f.groupIds.employee, { permissions: ALL.filter((p) => p !== "booking.recurring") }, admin);

    const error = await failure(series());

    assert.equal(error.status, 403);
    assert.match(error.message, /recurring/);

    await createBooking(input());
  });

  it("is granted again by ticking it", async () => {
    await updateGroup(f.groupIds.employee, { permissions: ALL.filter((p) => p !== "booking.recurring") }, admin);
    await updateGroup(f.groupIds.employee, { permissions: ALL }, admin);

    assert.equal((await series()).meetings.length, 2);
  });

  it("people with no group keep the default policy, which includes recurring meetings", async () => {
    assert.equal((await getBookingPolicy(f.users.dave.employeeId)).canBookRecurring, true);
  });
});

describe("room management permission", () => {
  it("the Admin role always may; others need a group that grants it", async () => {
    assert.equal(await canManageRooms(f.users.admin.employeeId, "Admin"), true);
    assert.equal(await canManageRooms(f.users.bob.employeeId, "Employee"), false);

    await updateGroup(f.groupIds.employee, { permissions: [...ALL, "rooms.manage"] }, admin);

    assert.equal(await canManageRooms(f.users.bob.employeeId, "Employee"), true);
    assert.equal(await canManageRooms(f.users.manager.employeeId, "Manager"), false, "another group is unaffected");

    await updateGroup(f.groupIds.employee, { permissions: ALL }, admin);

    assert.equal(await canManageRooms(f.users.bob.employeeId, "Employee"), false, "withdrawn");
  });
});

describe("Entra sync settings", () => {
  const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const person = (n: number, email: string) => ({ id: ID(n), displayName: `User ${n}`, mail: email, accountEnabled: true });

  const activeGroupOf = async (email: string) => {
    const [row] = await db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .innerJoin(employee, eq(employee.employee_id, userGroups.employeeId))
      .where(and(eq(employee.email, email), isNull(userGroups.effectiveUntil)));

    return row?.groupId ?? null;
  };

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE employee_sync_runs RESTART IDENTITY`);
    await db.update(employee).set({ entra_object_id: null });
    await updateEntraSettings({ autoSyncEnabled: false, intervalHours: 24, defaultGroupId: f.groupIds.employee }, admin);
  });

  it("saves the schedule and audits the change", async () => {
    await updateEntraSettings({ autoSyncEnabled: true, intervalHours: 168, defaultGroupId: f.groupIds.employee }, admin);

    const settings = await getEntraSettings();

    assert.equal(settings.autoSyncEnabled, true);
    assert.equal(settings.intervalHours, 168);
    assert.ok((await db.select().from(groupAuditLogs)).some((a) => a.action === "ENTRA_SETTINGS_UPDATED"));
  });

  it("the database only accepts the four interval presets", async () => {
    for (const hours of [1, 24, 168, 720]) {
      await updateEntraSettings({ autoSyncEnabled: true, intervalHours: hours, defaultGroupId: f.groupIds.employee }, admin);

      assert.equal((await getEntraSettings()).intervalHours, hours);
    }

    await assert.rejects(updateEntraSettings({ autoSyncEnabled: true, intervalHours: 6, defaultGroupId: f.groupIds.employee }, admin));
  });

  it("new people go to the group chosen in the settings, falling back to Employee", async () => {
    await updateEntraSettings({ autoSyncEnabled: false, intervalHours: 24, defaultGroupId: f.groupIds.tl }, admin);

    assert.equal((await getEntraSettings()).defaultGroupId, f.groupIds.tl);

    await syncEmployees({ actorEmployeeId: admin, users: [person(7, "chosen@example.test")] });

    assert.equal(await activeGroupOf("chosen@example.test"), f.groupIds.tl);

    // An inactive group is not used: the person falls back to Employee.
    await updateGroup(f.groupIds.tl, { isActive: false }, admin);
    await syncEmployees({ actorEmployeeId: admin, users: [person(8, "fallback@example.test")] });

    assert.equal(await activeGroupOf("fallback@example.test"), f.groupIds.employee);

    await updateGroup(f.groupIds.tl, { isActive: true }, admin);

    const error = await failure(
      updateEntraSettings({ autoSyncEnabled: false, intervalHours: 24, defaultGroupId: 99999 }, admin)
    );

    assert.ok(error instanceof GroupError, "an unknown group is refused");
  });

  it("everyone synced for the first time goes to the Employee group", async () => {
    const summary = await syncEmployees({
      actorEmployeeId: admin,
      users: [person(1, "new@example.test"), person(2, "plain@example.test")],
    });

    assert.equal(await activeGroupOf("new@example.test"), f.groupIds.employee);
    assert.equal(await activeGroupOf("plain@example.test"), f.groupIds.employee);
  });

  it("never moves someone who already has a group", async () => {
    await updateGroup(f.groupIds.manager, { isActive: true }, admin);

    const summary = await syncEmployees({
      actorEmployeeId: admin,
      users: [person(4, f.users.manager.email)],
    });

    assert.equal(summary.linked, 1);
    assert.equal(await activeGroupOf(f.users.manager.email), f.groupIds.manager);
  });

  describe("automatic sync", () => {
    const env = { ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c", ENTRA_CLIENT_SECRET: "s" };

    it("does nothing while it is switched off or not configured", async () => {
      assert.equal(await runScheduledSync(new Date(), env), false);

      await updateEntraSettings({ autoSyncEnabled: true, intervalHours: 1, defaultGroupId: f.groupIds.employee }, admin);

      assert.equal(await runScheduledSync(new Date(), {}), false, "no Entra credentials");
      assert.equal((await db.select().from(employeeSyncRuns)).length, 0);
    });

    it("waits for the interval after the last attempt", async () => {
      await updateEntraSettings({ autoSyncEnabled: true, intervalHours: 24, defaultGroupId: f.groupIds.employee }, admin);
      await db.insert(employeeSyncRuns).values({ status: "SUCCESS", finishedAt: new Date() });

      assert.equal(await runScheduledSync(new Date(), env), false, "the last sync was just now");
      assert.equal((await db.select().from(employeeSyncRuns)).length, 1);
    });

    it("the settings row is created if it was ever removed", async () => {
      await db.delete(entraSyncSettings);

      assert.equal((await getEntraSettings()).autoSyncEnabled, false);

      await updateEntraSettings({ autoSyncEnabled: true, intervalHours: 720, defaultGroupId: f.groupIds.employee }, admin);

      assert.equal((await getEntraSettings()).intervalHours, 720);
    });
  });
});
