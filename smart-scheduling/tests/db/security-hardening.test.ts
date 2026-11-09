import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  entraSyncSettings,
  groupPermissions,
  meetingTypes,
  organizers,
  userGroups,
} from "@/db/schema";
import { PERMISSION } from "@/lib/constants";
import { updateEntraSettings } from "@/lib/services/entra-settings.service";
import {
  assignEmployee,
  createGroup,
  deleteGroup,
  GroupError,
  listGroups,
  unassignEmployee,
  updateGroup,
  updateMeetingTypePriority,
} from "@/lib/services/group.service";
import {
  authorizeSignIn,
  normalizeEmail,
  resolveOrganizerByEmail,
} from "@/lib/services/identity.service";

import { seedFixtures, type Fixtures } from "../helpers/fixtures";

// Phase 1 security hardening: group management authorization, S-03 (inactive
// employees), S-05 (e-mail normalization and verified e-mail at sign-in).

let f: Fixtures;
let admin: number;
let mona: number; // Manager group, given group.manage below: a non-Admin group manager.

beforeEach(async () => {
  f = await seedFixtures();
  admin = f.users.admin.employeeId;
  mona = f.users.manager.employeeId;

  await db
    .update(groupPermissions)
    .set({ isEnabled: true })
    .where(
      and(
        eq(groupPermissions.groupId, f.groupIds.manager),
        eq(groupPermissions.permissionKey, PERMISSION.GROUP_MANAGE)
      )
    );
});

const newGroup = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: null,
  priority: 6,
  isActive: true,
  permissions: [PERMISSION.BOOKING_CREATE, PERMISSION.BOOKING_VIEW],
  meetingTypeIds: [],
  settings: { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: null },
  roomIds: [],
  ...extra,
});

async function refused(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );

  assert.ok(error instanceof GroupError, `expected a GroupError, got ${String(error)}`);
  assert.equal(error.status, 403);
}

const groupRow = async (id: number) => (await listGroups()).find((g) => g.id === id)!;

const activeGroupOf = async (employeeId: number) =>
  (
    await db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(and(eq(userGroups.employeeId, employeeId), isNull(userGroups.effectiveUntil)))
  )[0]?.groupId ?? null;

// What the Group Management form sends when someone edits only the
// description: everything else exactly as it is now.
async function formFor(groupId: number) {
  const g = await groupRow(groupId);

  return {
    name: g.name,
    description: g.description,
    priority: g.priority,
    isActive: g.isActive,
    permissions: g.permissions.filter((p) => p !== PERMISSION.BOOKING_PRIORITY),
    meetingTypeIds: g.meetingTypeIds,
    roomIds: g.roomIds,
  };
}

describe("Group Management permission is the only gate (no Admin role needed)", () => {
  it("a non-Admin group manager can change priority, permissions, meeting types and everything else of any group", async () => {
    const form = await formFor(f.groupIds.employee);

    await updateGroup(f.groupIds.employee, { ...form, priority: 2 }, mona);
    assert.equal((await groupRow(f.groupIds.employee)).priority, 2);

    for (const key of [PERMISSION.BOOKING_OUTRANKS, PERMISSION.BOOKING_PROTECTED]) {
      const current = await formFor(f.groupIds.employee);

      await updateGroup(f.groupIds.employee, { ...current, permissions: [...current.permissions, key] }, mona);
      assert.ok((await groupRow(f.groupIds.employee)).permissions.includes(key));
    }

    await updateGroup(f.groupIds.employee, { permissions: [], meetingTypeIds: [f.types.client] }, mona);

    const row = await groupRow(f.groupIds.employee);
    assert.deepEqual(row.permissions, []);
    assert.deepEqual(row.meetingTypeIds, [f.types.client]);
  });

  it("can edit name, description, order, rooms, status and booking policies of a group with administrative permissions", async () => {
    const policy = { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: null, maxBookingsPerDay: 2 };

    const updated = await updateGroup(
      f.groupIds.leadership,
      {
        ...(await formFor(f.groupIds.leadership)),
        name: "Leadership (renamed)",
        description: "edited by a group manager",
        priority: 3,
        roomIds: [f.rooms.alpha.room_id],
        settings: policy,
      },
      mona
    );

    assert.equal(updated.name, "Leadership (renamed)");

    const row = await groupRow(f.groupIds.leadership);
    assert.equal(row.description, "edited by a group manager");
    assert.equal(row.priority, 3);
    assert.deepEqual(row.roomIds, [f.rooms.alpha.room_id]);
    assert.equal(row.settings.maxBookingsPerDay, 2);

    await updateGroup(f.groupIds.leadership, { isActive: false }, mona);
    assert.equal((await groupRow(f.groupIds.leadership)).isActive, false);
  });

  it("can edit their own group, including its administrative permissions", async () => {
    const form = await formFor(f.groupIds.manager);

    await updateGroup(f.groupIds.manager, { ...form, permissions: [...form.permissions, PERMISSION.BOOKING_OUTRANKS] }, mona);
    assert.ok((await groupRow(f.groupIds.manager)).permissions.includes(PERMISSION.BOOKING_OUTRANKS));
  });

  it("can create groups, including privileged ones, and delete an unused group", async () => {
    const shadow = await createGroup(
      newGroup("Shadow Admins", { priority: 1, permissions: [PERMISSION.GROUP_MANAGE] }) as never,
      mona
    );

    assert.ok((await groupRow(shadow.id)).permissions.includes(PERMISSION.GROUP_MANAGE));

    await deleteGroup(shadow.id, mona);
    assert.ok(!(await listGroups()).some((g) => g.id === shadow.id));
  });

  it("can delete a privileged group that has no members or history", async () => {
    const board = await createGroup(newGroup("Board", { permissions: [PERMISSION.BOOKING_OUTRANKS] }) as never, admin);

    await deleteGroup(board.id, mona);
    assert.ok(!(await listGroups()).some((g) => g.id === board.id));
  });

  it("can change meeting type priorities", async () => {
    await updateMeetingTypePriority(f.types.others, 1, mona);

    const [type] = await db.select().from(meetingTypes).where(eq(meetingTypes.meetingTypeId, f.types.others));
    assert.equal(type.priorityRank, 1);
  });

  it("can move anyone, themselves and administrators included, into and out of any group", async () => {
    await assignEmployee(mona, f.groupIds.tl, mona);
    assert.equal(await activeGroupOf(mona), f.groupIds.tl);
    await assignEmployee(mona, f.groupIds.manager, admin);

    await assignEmployee(f.users.bob.employeeId, f.groupIds.leadership, mona);
    assert.equal(await activeGroupOf(f.users.bob.employeeId), f.groupIds.leadership);

    await assignEmployee(f.users.bob.employeeId, f.groupIds.hr, mona);
    assert.equal(await activeGroupOf(f.users.bob.employeeId), f.groupIds.hr);

    await unassignEmployee(f.users.bob.employeeId, mona);
    assert.equal(await activeGroupOf(f.users.bob.employeeId), null);

    await assignEmployee(admin, f.groupIds.tl, mona);
    assert.equal(await activeGroupOf(admin), f.groupIds.tl);
  });

  it("can move people into a group that ranks above their own", async () => {
    const vip = await createGroup(newGroup("VIP", { priority: 1 }) as never, admin);

    await assignEmployee(f.users.bob.employeeId, vip.id, mona);
    assert.equal(await activeGroupOf(f.users.bob.employeeId), vip.id);
  });

  it("can make any group the Entra sync default", async () => {
    await updateEntraSettings({ autoSyncEnabled: true, intervalHours: 24, defaultGroupId: f.groupIds.leadership }, mona);

    const [saved] = await db.select().from(entraSyncSettings);
    assert.equal(saved.defaultGroupId, f.groupIds.leadership);
  });

  it("an edit that resends the whole form unchanged is accepted", async () => {
    const form = await formFor(f.groupIds.tl);
    const updated = await updateGroup(
      f.groupIds.tl,
      { ...form, description: "Team leads (edited)", roomIds: [f.rooms.alpha.room_id] },
      mona
    );

    assert.equal(updated.description, "Team leads (edited)");
    assert.deepEqual((await groupRow(f.groupIds.tl)).roomIds, [f.rooms.alpha.room_id]);
  });
});

describe("Without the Group Management permission nothing can be changed", () => {
  // Bob (Employee group) has no group.manage and is not an Admin.
  let bob: number;

  beforeEach(() => {
    bob = f.users.bob.employeeId;
  });

  it("is refused for every group management operation", async () => {
    const before = await groupRow(f.groupIds.employee);

    await refused(updateGroup(f.groupIds.employee, { ...(await formFor(f.groupIds.employee)), description: "x" }, bob));
    await refused(updateGroup(f.groupIds.employee, { priority: 1 }, bob));
    await refused(createGroup(newGroup("Interns") as never, bob));
    await refused(deleteGroup(f.groupIds.hr, bob));
    await refused(updateMeetingTypePriority(f.types.others, 1, bob));
    await refused(assignEmployee(f.users.carol.employeeId, f.groupIds.tl, bob));
    await refused(unassignEmployee(f.users.carol.employeeId, bob));
    await refused(
      updateEntraSettings({ autoSyncEnabled: true, intervalHours: 24, defaultGroupId: f.groupIds.tl }, bob)
    );

    const after = await groupRow(f.groupIds.employee);
    assert.equal(after.description, before.description);
    assert.equal(after.priority, before.priority);
    assert.ok(!(await listGroups()).some((g) => g.name === "Interns"));
    assert.equal(await activeGroupOf(f.users.carol.employeeId), f.groupIds.employee);
  });

  it("is refused for a deactivated employee even with the permission", async () => {
    await db.update(employee).set({ is_active: false }).where(eq(employee.employee_id, mona));

    await refused(updateGroup(f.groupIds.employee, { priority: 1 }, mona));
    await refused(assignEmployee(f.users.bob.employeeId, f.groupIds.tl, mona));
  });
});

describe("Admins keep full group management", () => {
  it("creates privileged groups, changes priorities and permissions, assigns anyone", async () => {
    const group = await createGroup(
      newGroup("Board", { priority: 1, permissions: [PERMISSION.BOOKING_OUTRANKS, PERMISSION.GROUP_MANAGE] }) as never,
      admin
    );

    await updateGroup(group.id, { priority: 2, permissions: [PERMISSION.BOOKING_PROTECTED] }, admin);

    const row = await groupRow(group.id);
    assert.equal(row.priority, 2);
    assert.deepEqual(row.permissions, [PERMISSION.BOOKING_PROTECTED]);

    await assignEmployee(f.users.bob.employeeId, f.groupIds.leadership, admin);
    assert.equal(await activeGroupOf(f.users.bob.employeeId), f.groupIds.leadership);

    await updateMeetingTypePriority(f.types.others, 2, admin);
    await updateEntraSettings({ autoSyncEnabled: false, intervalHours: 24, defaultGroupId: f.groupIds.leadership }, admin);
  });

  it("a deactivated administrator can no longer change anything", async () => {
    await db.update(employee).set({ is_active: false }).where(eq(employee.employee_id, admin));

    await refused(updateGroup(f.groupIds.employee, { priority: 1 }, admin));
    await refused(assignEmployee(f.users.bob.employeeId, f.groupIds.leadership, admin));
  });
});

describe("S-05: e-mail normalization and verified e-mail at sign-in", () => {
  const attempt = (email: string | null, emailVerified = true) => ({
    email,
    emailVerified,
    name: "Someone",
    image: null,
  });

  it("normalizes case and surrounding spaces", () => {
    assert.equal(normalizeEmail("  Bob.Emp@Example.TEST "), "bob.emp@example.test");
  });

  it("signs in whatever the case of the address, and stores the Organizer copy in lower case", async () => {
    assert.equal(await authorizeSignIn(attempt("DAVE.NoLogin@Example.test")), true);

    const [row] = await db.select().from(organizers).where(eq(organizers.employeeId, f.users.dave.employeeId));
    assert.equal(row.email, "dave.nologin@example.test");

    const resolved = await resolveOrganizerByEmail("Dave.NOLOGIN@example.TEST");
    assert.equal(resolved?.employeeId, f.users.dave.employeeId);
  });

  it("an Employee row entered with capitals still matches", async () => {
    await db
      .update(employee)
      .set({ email: "Carol.Emp@Example.test" })
      .where(eq(employee.employee_id, f.users.carol.employeeId));

    assert.equal(await authorizeSignIn(attempt("carol.emp@example.test")), true);
    assert.equal((await resolveOrganizerByEmail("carol.emp@example.test"))?.employeeId, f.users.carol.employeeId);
  });

  it("refuses an unverified address without creating anything", async () => {
    assert.equal(await authorizeSignIn(attempt("dave.nologin@example.test", false)), "unverified-email");

    const rows = await db.select().from(organizers).where(eq(organizers.employeeId, f.users.dave.employeeId));
    assert.equal(rows.length, 0);
  });

  it("refuses unknown and missing addresses", async () => {
    assert.equal(await authorizeSignIn(attempt("stranger@example.test")), "not-authorized");
    assert.equal(await authorizeSignIn(attempt(null)), "not-authorized");
  });

  it("refuses an address that matches two rows differing only in case", async () => {
    await db.insert(employee).values({
      role_id: (await db.select().from(employee).where(eq(employee.employee_id, f.users.bob.employeeId)))[0].role_id,
      employee_name: "Bob Twin",
      email: "BOB.EMP@example.test",
    });

    assert.equal(await authorizeSignIn(attempt("bob.emp@example.test")), "not-authorized");
  });
});

describe("S-03: inactive employees", () => {
  const deactivate = (employeeId: number) =>
    db.update(employee).set({ is_active: false, deactivated_at: new Date() }).where(eq(employee.employee_id, employeeId));

  it("existing employees are active by default", async () => {
    const rows = await db.select({ active: employee.is_active }).from(employee);
    assert.ok(rows.length > 0 && rows.every((r) => r.active));
  });

  it("cannot sign in", async () => {
    await deactivate(f.users.bob.employeeId);

    assert.equal(
      await authorizeSignIn({ email: f.users.bob.email, emailVerified: true, name: "Bob", image: null }),
      "not-authorized"
    );
  });

  it("cannot act as an organizer with a session they already had", async () => {
    assert.ok(await resolveOrganizerByEmail(f.users.bob.email));

    await deactivate(f.users.bob.employeeId);

    assert.equal(await resolveOrganizerByEmail(f.users.bob.email), null);
  });

  it("other employees are unaffected", async () => {
    await deactivate(f.users.bob.employeeId);

    assert.equal((await resolveOrganizerByEmail(f.users.carol.email))?.employeeId, f.users.carol.employeeId);
  });
});
