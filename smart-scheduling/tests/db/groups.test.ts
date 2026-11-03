import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  groupAuditLogs,
  groupPermissions,
  groups,
  userGroups,
} from "@/db/schema";
import { DEFAULT_GROUPS } from "@/db/seed-groups";
import { dbErrorCode, PG_UNIQUE_VIOLATION } from "@/lib/api";
import { DEFAULT_PERMISSIONS, PERMISSION } from "@/lib/constants";
import { getPriorityContext } from "@/lib/services/group-context.service";
import {
  assignEmployee,
  createGroup,
  deleteGroup,
  getEmployeeGroupHistory,
  GroupError,
  listEmployees,
  listGroups,
  unassignEmployee,
  updateGroup,
} from "@/lib/services/group.service";
import { createBooking } from "@/lib/services/booking.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";

let f: Fixtures;
let admin: number;

before(async () => {
  f = await seedFixtures();
  admin = f.users.admin.employeeId;
});

// Every test starts from the seeded defaults, with Admin/Dave unassigned.
beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE booking_priority_history, group_audit_logs, meeting_audit_logs,
      reminder_logs, notifications, reschedule_requests, meeting_attendees,
      meeting, recurring_meetings
    RESTART IDENTITY CASCADE
  `);
  await db.delete(groups).where(sql`name NOT IN (${sql.join(DEFAULT_GROUPS.map((g) => sql`${g.name}`), sql`, `)})`).catch(() => undefined);

  for (const g of DEFAULT_GROUPS) {
    await db
      .update(groups)
      .set({ priority: g.priority, isActive: true, name: g.name })
      .where(eq(groups.name, g.name));
  }

  // Permissions back to the seeded defaults (rows may have been rewritten).
  await db.execute(sql`
    INSERT INTO group_permissions (group_id, permission_key, is_enabled)
    SELECT g.id, p.key, (p.key <> 'dashboard.view' OR g.name IN ('HR', 'Admin'))
    FROM groups g CROSS JOIN (VALUES
      ('dashboard.view'), ('booking.create'), ('booking.view'),
      ('booking.cancel'), ('booking.priority')) AS p(key)
    WHERE g.name IN ('Leadership', 'HR', 'Manager', 'TL', 'Employee', 'Admin')
    ON CONFLICT (group_id, permission_key) DO UPDATE SET is_enabled = excluded.is_enabled
  `);

  await db.execute(sql`DELETE FROM user_groups`);
  await db.insert(userGroups).values([
    { employeeId: f.users.manager.employeeId, groupId: f.groupIds.manager },
    { employeeId: f.users.bob.employeeId, groupId: f.groupIds.employee },
    { employeeId: f.users.carol.employeeId, groupId: f.groupIds.employee },
  ]);
});

const newGroup = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: null,
  priority: 6,
  isActive: true,
  permissions: [PERMISSION.BOOKING_CREATE, PERMISSION.BOOKING_VIEW],
  ...extra,
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  assert.fail("expected a rejection");
}

describe("seeded defaults", () => {
  it("has the default groups at priorities 1 to 5, Admin included as an ordinary group", async () => {
    const rows = await listGroups();

    assert.deepEqual(
      rows.map((g) => [g.name, g.priority]),
      [["Leadership", 1], ["HR", 2], ["Manager", 3], ["TL", 4], ["Employee", 5], ["Admin", 5]]
    );
  });

  it("gives only HR and Admin the dashboard permission by default, and everyone booking access", async () => {
    const rows = await listGroups();

    for (const g of rows) {
      assert.equal(g.permissions.includes(PERMISSION.DASHBOARD_VIEW), g.name === "HR" || g.name === "Admin", g.name);
      assert.ok(g.permissions.includes(PERMISSION.BOOKING_CREATE));
    }
  });
});

describe("group CRUD", () => {
  it("creates a group with its permissions and audits it", async () => {
    const group = await createGroup(newGroup("Interns") as never, admin);

    const [row] = (await listGroups()).filter((g) => g.id === group.id);
    assert.equal(row.priority, 6);
    assert.deepEqual([...row.permissions].sort(), [PERMISSION.BOOKING_CREATE, PERMISSION.BOOKING_VIEW]);

    const audit = await db.select().from(groupAuditLogs);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "GROUP_CREATED");
    assert.equal(audit[0].actorEmployeeId, admin);
  });

  it("rejects a duplicate name, whatever its case", async () => {
    const error = await failure(createGroup(newGroup("leadership") as never, admin));

    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 409);
  });

  it("edits name, description, priority, status and permissions", async () => {
    const group = await createGroup(newGroup("Interns") as never, admin);

    const updated = await updateGroup(
      group.id,
      {
        name: "Trainees",
        description: "Short-term staff",
        priority: 7,
        isActive: false,
        permissions: [PERMISSION.DASHBOARD_VIEW],
      },
      admin
    );

    assert.equal(updated.name, "Trainees");
    assert.equal(updated.priority, 7);
    assert.equal(updated.isActive, false);

    const [row] = (await listGroups()).filter((g) => g.id === group.id);
    assert.deepEqual(row.permissions, [PERMISSION.DASHBOARD_VIEW]);

    const actions = (await db.select().from(groupAuditLogs)).map((a) => a.action);
    assert.deepEqual(actions, ["GROUP_CREATED", "GROUP_UPDATED"]);
  });

  it("reports an unknown group", async () => {
    const error = await failure(updateGroup(9999, { name: "x" }, admin));

    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 404);
  });

  it("counts the real members of each group", async () => {
    const before = await listGroups();
    const count = (name: string) => before.find((g) => g.name === name)!.employeeCount;

    // Bob and Carol are Employees, Mona is a Manager (see the fixtures).
    assert.equal(count("Employee"), 2);
    assert.equal(count("Manager"), 1);
    assert.equal(count("Leadership"), 0);

    await assignEmployee(f.users.bob.employeeId, f.groupIds.leadership, admin);

    const after = await listGroups();
    const n = (name: string) => after.find((g) => g.name === name)!.employeeCount;

    assert.equal(n("Employee"), 1);
    assert.equal(n("Leadership"), 1, "history rows are not counted, only open ones");
  });

  it("saves the meeting types a group may use, rejecting unknown ids", async () => {
    await updateGroup(f.groupIds.tl, { meetingTypeIds: [f.types.client, f.types.team] }, admin);

    const tl = (await listGroups()).find((g) => g.id === f.groupIds.tl)!;
    assert.deepEqual([...tl.meetingTypeIds].sort(), [f.types.client, f.types.team].sort());

    await updateGroup(f.groupIds.tl, { meetingTypeIds: [] }, admin);
    assert.deepEqual((await listGroups()).find((g) => g.id === f.groupIds.tl)!.meetingTypeIds, []);

    const error = await failure(updateGroup(f.groupIds.tl, { meetingTypeIds: [99999] }, admin));
    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 400);
  });
});

describe("deleting groups", () => {
  it("deletes an unused group", async () => {
    const group = await createGroup(newGroup("Temp") as never, admin);

    await deleteGroup(group.id, admin);

    assert.equal((await db.select().from(groups).where(eq(groups.id, group.id))).length, 0);
    assert.equal(
      (await db.select().from(groupPermissions).where(eq(groupPermissions.groupId, group.id))).length,
      0
    );

    const audit = await db.select().from(groupAuditLogs);
    assert.ok(audit.some((a) => a.action === "GROUP_DELETED" && a.groupId === group.id));
  });

  it("refuses a group that still has employees", async () => {
    const error = await failure(deleteGroup(f.groupIds.employee, admin));

    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 409);
    assert.match(error.message, /Deactivate/);
  });

  it("refuses a group with booking history even after everyone has left", async () => {
    await createBooking({
      title: "Old booking",
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [dateFromToday(5)],
      startTime: "10:00",
      endTime: "11:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Manager",
      participantCount: 1,
      meetingTypeId: f.types.team,
      notify: false,
    });
    await unassignEmployee(f.users.bob.employeeId, admin);
    await unassignEmployee(f.users.carol.employeeId, admin);
    await db.execute(sql`DELETE FROM user_groups WHERE group_id = ${f.groupIds.employee}`);

    const error = await failure(deleteGroup(f.groupIds.employee, admin));

    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 409);
  });
});

describe("employee assignment", () => {
  it("assigns an unassigned employee", async () => {
    const result = await assignEmployee(f.users.dave.employeeId, f.groupIds.tl, admin);

    assert.equal(result.changed, true);
    assert.equal((await getPriorityContext(f.users.dave.employeeId)).groupId, f.groupIds.tl);
  });

  it("moves an employee, closing the old assignment and keeping the history", async () => {
    await assignEmployee(f.users.bob.employeeId, f.groupIds.tl, admin);

    const history = await getEmployeeGroupHistory(f.users.bob.employeeId);
    assert.equal(history.length, 2);
    assert.equal(history[0].groupName, "TL");
    assert.equal(history[0].effectiveUntil, null);
    assert.equal(history[1].groupName, "Employee");
    assert.ok(history[1].effectiveUntil, "previous assignment is closed, not deleted");

    const active = await db
      .select()
      .from(userGroups)
      .where(and(eq(userGroups.employeeId, f.users.bob.employeeId), isNull(userGroups.effectiveUntil)));
    assert.equal(active.length, 1);
  });

  it("does nothing when the employee is already in that group", async () => {
    const result = await assignEmployee(f.users.bob.employeeId, f.groupIds.employee, admin);

    assert.equal(result.changed, false);
    assert.equal((await getEmployeeGroupHistory(f.users.bob.employeeId)).length, 1);
  });

  it("the database itself refuses a second active group for one employee", async () => {
    const error = await failure(
      db.insert(userGroups).values({ employeeId: f.users.bob.employeeId, groupId: f.groupIds.tl })
    );

    assert.equal(dbErrorCode(error), PG_UNIQUE_VIOLATION);
  });

  it("concurrent assignments still leave exactly one active group", async () => {
    await Promise.allSettled([
      assignEmployee(f.users.dave.employeeId, f.groupIds.tl, admin),
      assignEmployee(f.users.dave.employeeId, f.groupIds.hr, admin),
      assignEmployee(f.users.dave.employeeId, f.groupIds.manager, admin),
    ]);

    const active = await db
      .select()
      .from(userGroups)
      .where(and(eq(userGroups.employeeId, f.users.dave.employeeId), isNull(userGroups.effectiveUntil)));

    assert.equal(active.length, 1);
  });

  it("refuses an inactive group", async () => {
    await updateGroup(f.groupIds.tl, { isActive: false }, admin);

    const error = await failure(assignEmployee(f.users.dave.employeeId, f.groupIds.tl, admin));

    assert.ok(error instanceof GroupError);
    assert.equal(error.status, 409);
    assert.equal((await getPriorityContext(f.users.dave.employeeId)).groupId, null);
  });

  it("refuses unknown employees and groups", async () => {
    const noEmployee = await failure(assignEmployee(9999, f.groupIds.tl, admin));
    const noGroup = await failure(assignEmployee(f.users.dave.employeeId, 9999, admin));

    assert.equal((noEmployee as GroupError).status, 404);
    assert.equal((noGroup as GroupError).status, 404);
  });

  it("removes an assignment and falls back to the default policy", async () => {
    await unassignEmployee(f.users.bob.employeeId, admin);

    const context = await getPriorityContext(f.users.bob.employeeId);
    assert.equal(context.groupId, null);
    assert.equal(context.canPreempt, false);

    const error = await failure(unassignEmployee(f.users.bob.employeeId, admin));
    assert.equal((error as GroupError).status, 404);
  });

  it("audits every change with actor, group and employee", async () => {
    await assignEmployee(f.users.dave.employeeId, f.groupIds.tl, admin);
    await assignEmployee(f.users.dave.employeeId, f.groupIds.hr, admin);
    await unassignEmployee(f.users.dave.employeeId, admin);

    const audit = await db.select().from(groupAuditLogs);

    assert.deepEqual(audit.map((a) => a.action), [
      "EMPLOYEE_ASSIGNED",
      "EMPLOYEE_GROUP_CHANGED",
      "EMPLOYEE_UNASSIGNED",
    ]);
    assert.ok(audit.every((a) => a.actorEmployeeId === admin && a.targetEmployeeId === f.users.dave.employeeId));
  });

  it("searches by name or email and filters by group", async () => {
    const byName = await listEmployees({ search: "mona", page: 1, pageSize: 10 });
    assert.deepEqual(byName.rows.map((r) => r.email), [f.users.manager.email]);

    const byEmail = await listEmployees({ search: "carol.emp@", page: 1, pageSize: 10 });
    assert.equal(byEmail.total, 1);

    const inGroup = await listEmployees({ groupId: f.groupIds.employee, page: 1, pageSize: 10 });
    assert.equal(inGroup.total, 2);

    const none = await listEmployees({ groupId: "none", page: 1, pageSize: 10 });
    assert.deepEqual(none.rows.map((r) => r.name).sort(), ["Alice Admin", "Dave NoLogin"]);

    // LIKE wildcards in the search are literal characters.
    assert.equal((await listEmployees({ search: "%", page: 1, pageSize: 10 })).total, 0);
  });
});

describe("priority context (trusted standing)", () => {
  it("reads group, priority and permissions from the database", async () => {
    const context = await getPriorityContext(f.users.manager.employeeId);

    assert.equal(context.groupName, "Manager");
    assert.equal(context.priority, 3);
    assert.equal(context.canPreempt, true);
    assert.equal(context.permissions.has(PERMISSION.DASHBOARD_VIEW), false);
  });

  it("follows permission changes immediately", async () => {
    await updateGroup(f.groupIds.manager, { permissions: [PERMISSION.DASHBOARD_VIEW] }, admin);

    const context = await getPriorityContext(f.users.manager.employeeId);

    assert.equal(context.permissions.has(PERMISSION.DASHBOARD_VIEW), true);
    assert.equal(context.permissions.has(PERMISSION.BOOKING_CREATE), false);
    assert.equal(context.canPreempt, false);
  });

  it("gives an unassigned employee the lowest priority, booking basics and nothing more", async () => {
    const context = await getPriorityContext(f.users.dave.employeeId);

    assert.equal(context.groupId, null);
    assert.equal(context.priority, 5, "the lowest active group, never the highest");
    assert.deepEqual([...context.permissions].sort(), [...DEFAULT_PERMISSIONS].sort());
    assert.equal(context.canPreempt, false);
  });

  it("follows the lowest ACTIVE group when the bottom group is deactivated", async () => {
    await updateGroup(f.groupIds.employee, { isActive: false }, admin);

    assert.equal((await getPriorityContext(f.users.dave.employeeId)).priority, 4);
    assert.equal(
      (await getPriorityContext(f.users.bob.employeeId)).groupId,
      null,
      "members of an inactive group get the default policy"
    );
  });
});

describe("append-only audit tables", () => {
  const refused = (error: unknown) => dbErrorCode(error) === "42501";

  it("rejects UPDATE and DELETE on group_audit_logs", async () => {
    await createGroup(newGroup("Interns") as never, admin);

    assert.ok(refused(await failure(db.update(groupAuditLogs).set({ action: "x" }))));
    assert.ok(refused(await failure(db.delete(groupAuditLogs))));
    assert.equal((await db.select().from(groupAuditLogs)).length, 1);
  });

  it("rejects UPDATE and DELETE on booking_priority_history", async () => {
    const day = dateFromToday(6);
    const base = {
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [day],
      startTime: "10:00",
      endTime: "11:00",
      organizerRole: "Manager",
      participantCount: 1,
      meetingTypeId: f.types.team,
      notify: false,
    };

    await createBooking({ ...base, title: "Low", organizerEmployeeId: f.users.bob.employeeId });
    await createBooking({ ...base, title: "High", organizerEmployeeId: f.users.manager.employeeId });

    assert.equal((await db.select().from(bookingPriorityHistory)).length, 1);
    assert.ok(refused(await failure(db.update(bookingPriorityHistory).set({ reason: "edited" }))));
    assert.ok(refused(await failure(db.delete(bookingPriorityHistory))));
  });
});
