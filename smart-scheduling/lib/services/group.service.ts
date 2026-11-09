import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  employee,
  groupAuditLogs,
  groupMeetingTypes,
  groupPermissions,
  groupRooms,
  groupSettings,
  groups,
  meeting,
  meetingTypes,
  roles,
  room,
  userGroups,
} from "@/db/schema";
import { dbErrorCode, PG_UNIQUE_VIOLATION } from "@/lib/api";
import {
  ALL_PERMISSIONS,
  PERMISSION,
  PRIVILEGED_PERMISSIONS,
  ROLE_ADMIN,
} from "@/lib/constants";
import type { DbExecutor, Tx } from "@/lib/db-types";
import {
  groupPolicyProblem,
  type GroupBookingPolicy,
  type OvernightSetting,
} from "@/lib/booking-limits";
import type {
  CreateGroupInput,
  UpdateGroupInput,
} from "@/lib/validations/group.validator";

import { getAppBookingPolicy, getGroupBookingPolicy } from "./booking-limits.service";
import { getPriorityContext } from "./group-context.service";

// Admin-side management of application groups, their permissions and the
// employee -> group assignments. Everything here lives in OUR database; Entra /
// Google only identify the employee. Callers (the API routes) must already have
// checked that the actor may use Group Management at all (requireGroupManagement).
// This module then decides what the actor may change, from the actor's role and
// group read from the database:
//
//  * The Admin role may do everything.
//  * Anyone else (a group with `group.manage`) may NOT create groups, change any
//    group's permissions, meeting types or priority, or meeting type
//    priorities; may not edit or delete a privileged group (one granting any
//    of PRIVILEGED_PERMISSIONS); and may only move people who are not Admins,
//    not themselves, between non-privileged groups that do not rank above the
//    actor's own group.

export const GROUP_AUDIT = {
  CREATED: "GROUP_CREATED",
  UPDATED: "GROUP_UPDATED",
  DELETED: "GROUP_DELETED",
  ASSIGNED: "EMPLOYEE_ASSIGNED",
  CHANGED: "EMPLOYEE_GROUP_CHANGED",
  REMOVED: "EMPLOYEE_UNASSIGNED",
  MEETING_TYPE_PRIORITY: "MEETING_TYPE_PRIORITY_CHANGED",
  // A group's overnight choice, duration or day/week/month limits changed
  // (details: before and after). The application-wide ones are
  // APP_BOOKING_POLICY_CHANGED (booking-settings.service).
  BOOKING_POLICY: "GROUP_BOOKING_POLICY_CHANGED",
} as const;

export class GroupError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GroupError";
    this.status = status;
  }
}

async function audit(
  tx: Tx,
  actorEmployeeId: number,
  action: string,
  details: Record<string, unknown>,
  groupId?: number | null,
  targetEmployeeId?: number | null
) {
  await tx.insert(groupAuditLogs).values({
    actorEmployeeId,
    action,
    groupId: groupId ?? null,
    targetEmployeeId: targetEmployeeId ?? null,
    details,
  });
}

function mapConflict(error: unknown): never {
  if (dbErrorCode(error) === PG_UNIQUE_VIOLATION) {
    const text = String((error as { cause?: { constraint?: string } })?.cause
      ?.constraint ?? "");

    if (text.includes("groups_name")) {
      throw new GroupError("A group with this name already exists.", 409);
    }

    throw new GroupError(
      "The employee already has an active group. Reload and try again.",
      409
    );
  }

  throw error;
}

/* ---------------------------- authorization ------------------------------ */

type Actor = {
  employeeId: number;
  isAdmin: boolean;
  // Admin role, or a group that grants group.manage (Group Management access).
  mayManageGroups: boolean;
  // The actor's own group standing (1 = highest).
  groupId: number | null;
  priority: number;
};

async function loadActor(
  executor: DbExecutor,
  actorEmployeeId: number
): Promise<Actor> {
  const [row] = await executor
    .select({ role: roles.roleName })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(
      and(eq(employee.employee_id, actorEmployeeId), eq(employee.is_active, true))
    );

  if (!row) throw new GroupError("You do not have permission to do this.", 403);

  const standing = await getPriorityContext(actorEmployeeId, executor);

  return {
    employeeId: actorEmployeeId,
    isAdmin: row.role === ROLE_ADMIN,
    mayManageGroups:
      row.role === ROLE_ADMIN || standing.permissions.has(PERMISSION.GROUP_MANAGE),
    groupId: standing.groupId,
    priority: standing.priority,
  };
}

function adminOnly(message: string): never {
  throw new GroupError(message, 403);
}

async function isPrivilegedGroup(executor: DbExecutor, groupId: number) {
  const [row] = await executor
    .select({ key: groupPermissions.permissionKey })
    .from(groupPermissions)
    .where(
      and(
        eq(groupPermissions.groupId, groupId),
        eq(groupPermissions.isEnabled, true),
        inArray(groupPermissions.permissionKey, PRIVILEGED_PERMISSIONS)
      )
    )
    .limit(1);

  return Boolean(row);
}

const sameSet = <T>(a: T[], b: T[]) => {
  const left = new Set(a);
  const right = new Set(b);

  return left.size === right.size && [...left].every((v) => right.has(v));
};

// The edit form sends the whole group back, unchanged permissions and
// priority included; only a real change counts. The legacy booking.priority
// key is not offered by the form, so it is left out of the comparison.
async function changesPermissionsOrPriority(
  tx: Tx,
  before: typeof groups.$inferSelect,
  input: UpdateGroupInput
) {
  if (input.priority !== undefined && input.priority !== before.priority) {
    return true;
  }

  if (input.permissions) {
    const current = await tx
      .select({ key: groupPermissions.permissionKey })
      .from(groupPermissions)
      .where(
        and(
          eq(groupPermissions.groupId, before.id),
          eq(groupPermissions.isEnabled, true)
        )
      );
    const legacy = (key: string) => key !== PERMISSION.BOOKING_PRIORITY;

    if (
      !sameSet(
        current.map((p) => p.key).filter(legacy),
        input.permissions.filter(legacy)
      )
    ) {
      return true;
    }
  }

  if (input.meetingTypeIds) {
    const current = await tx
      .select({ id: groupMeetingTypes.meetingTypeId })
      .from(groupMeetingTypes)
      .where(eq(groupMeetingTypes.groupId, before.id));

    if (!sameSet(current.map((t) => t.id), input.meetingTypeIds)) return true;
  }

  return false;
}

// Does this edit change anything besides the group's booking policies
// (overnight choice, longest meeting, bookings per day / week / month)? Those
// are open to everyone who may manage groups, even for a group with
// administrative permissions; everything else about such a group stays with
// administrators.
async function changesBeyondSettings(
  tx: Tx,
  before: typeof groups.$inferSelect,
  input: UpdateGroupInput
) {
  if (input.name !== undefined && input.name !== before.name) return true;

  if (input.description !== undefined && input.description !== before.description) {
    return true;
  }

  if (input.isActive !== undefined && input.isActive !== before.isActive) return true;

  if (await changesPermissionsOrPriority(tx, before, input)) return true;

  if (input.roomIds) {
    const current = await tx
      .select({ id: groupRooms.roomId })
      .from(groupRooms)
      .where(eq(groupRooms.groupId, before.id));

    if (!sameSet(current.map((r) => r.id), input.roomIds)) return true;
  }

  return false;
}

// Whether a non-Admin actor may move `employeeId` out of `fromGroupId` (their
// current group, if any) and into `toGroupId` (null = unassign).
async function assertMayReassign(
  tx: Tx,
  actor: Actor,
  employeeId: number,
  fromGroupId: number | null,
  toGroupId: number | null
) {
  if (actor.isAdmin) return;

  if (employeeId === actor.employeeId) {
    adminOnly("You cannot change your own group.");
  }

  const [target] = await tx
    .select({ role: roles.roleName })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(eq(employee.employee_id, employeeId));

  if (target?.role === ROLE_ADMIN) {
    adminOnly("Only an administrator can change an administrator's group.");
  }

  for (const groupId of [fromGroupId, toGroupId]) {
    if (groupId === null) continue;

    if (await isPrivilegedGroup(tx, groupId)) {
      adminOnly(
        "Only an administrator can move people into or out of a group with administrative permissions."
      );
    }

    const [group] = await tx
      .select({ priority: groups.priority })
      .from(groups)
      .where(eq(groups.id, groupId));

    if (group && group.priority < actor.priority) {
      adminOnly(
        "You cannot move people into or out of a group that ranks above your own."
      );
    }
  }
}

// The Entra sync places everyone without a group in the default group, so
// choosing it is an assignment: the same rules as moving people into it.
export async function assertMaySetDefaultGroup(
  actorEmployeeId: number,
  groupId: number
) {
  const actor = await loadActor(db, actorEmployeeId);

  if (actor.isAdmin) return;

  if (await isPrivilegedGroup(db, groupId)) {
    adminOnly(
      "Only an administrator can make a group with administrative permissions the default."
    );
  }

  const [group] = await db
    .select({ priority: groups.priority })
    .from(groups)
    .where(eq(groups.id, groupId));

  if (group && group.priority < actor.priority) {
    adminOnly("You cannot make a group that ranks above your own the default.");
  }
}

/* ------------------------------- groups ---------------------------------- */

export async function listGroups() {
  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      priority: groups.priority,
      isActive: groups.isActive,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
    })
    .from(groups)
    .orderBy(asc(groups.priority), asc(groups.id));

  // Members per group, counted from the real assignments (open rows only).
  const counts = await db
    .select({ groupId: userGroups.groupId, n: count() })
    .from(userGroups)
    .innerJoin(employee, eq(employee.employee_id, userGroups.employeeId))
    .where(isNull(userGroups.effectiveUntil))
    .groupBy(userGroups.groupId);

  const types = await db
    .select({
      groupId: groupMeetingTypes.groupId,
      meetingTypeId: groupMeetingTypes.meetingTypeId,
    })
    .from(groupMeetingTypes);

  const limits = await db.select().from(groupSettings);
  const rooms = await db.select().from(groupRooms);

  const perms = await db
    .select({
      groupId: groupPermissions.groupId,
      key: groupPermissions.permissionKey,
    })
    .from(groupPermissions)
    .where(eq(groupPermissions.isEnabled, true));

  return rows.map((g) => ({
    ...g,
    employeeCount: counts.find((c) => c.groupId === g.id)?.n ?? 0,
    permissions: perms.filter((p) => p.groupId === g.id).map((p) => p.key),
    meetingTypeIds: types
      .filter((t) => t.groupId === g.id)
      .map((t) => t.meetingTypeId),
    settings: {
      maxDurationMinutes:
        limits.find((l) => l.groupId === g.id)?.maxDurationMinutes ?? null,
      maxAdvanceDays:
        limits.find((l) => l.groupId === g.id)?.maxAdvanceDays ?? null,
      maxOccurrences:
        limits.find((l) => l.groupId === g.id)?.maxOccurrences ?? null,
      overnightPolicy: (limits.find((l) => l.groupId === g.id)?.overnightPolicy ??
        "INHERIT") as OvernightSetting,
      maxBookingsPerDay:
        limits.find((l) => l.groupId === g.id)?.maxBookingsPerDay ?? null,
      maxBookingsPerWeek:
        limits.find((l) => l.groupId === g.id)?.maxBookingsPerWeek ?? null,
      maxBookingsPerMonth:
        limits.find((l) => l.groupId === g.id)?.maxBookingsPerMonth ?? null,
    },
    // Empty = every room.
    roomIds: rooms.filter((r) => r.groupId === g.id).map((r) => r.roomId),
  }));
}

// Every room, for the room picker.
export async function listRoomOptions() {
  // Archived rooms cannot be booked, so they are not offered for a group's
  // room list (a list that already names one keeps it harmlessly).
  return db
    .select({ id: room.room_id, name: room.room_name })
    .from(room)
    .where(isNull(room.archived_at))
    .orderBy(asc(room.room_name));
}

type SettingsInput = NonNullable<UpdateGroupInput["settings"]>;

// Saves a group's limits and booking policies. Booking-policy fields that the
// request leaves out keep their stored value. Returns the policy before and
// after, for the audit trail.
//  * Only someone who may manage groups (the Admin role, or a group that
//    grants group.manage) may change the overnight choice or the per-day /
//    week / month limits.
//  * A group can never exceed the application's limits, nor allow overnight
//    bookings while the application forbids them. Only fields THAT CHANGE are
//    checked: a limit the application lowered later is left as it is (the
//    effective rule is the stricter of the two, lib/booking-limits.ts), so an
//    unrelated edit of the group is never blocked by an old value.
async function writeSettings(
  tx: Tx,
  groupId: number,
  values: SettingsInput,
  actorMayManageGroups: boolean
): Promise<{ before: GroupBookingPolicy; after: GroupBookingPolicy }> {
  const before = await getGroupBookingPolicy(groupId, tx);

  const after: GroupBookingPolicy = {
    overnight: values.overnightPolicy ?? before.overnight,
    maxDurationMinutes: values.maxDurationMinutes,
    maxBookingsPerDay:
      values.maxBookingsPerDay === undefined ? before.maxBookingsPerDay : values.maxBookingsPerDay,
    maxBookingsPerWeek:
      values.maxBookingsPerWeek === undefined ? before.maxBookingsPerWeek : values.maxBookingsPerWeek,
    maxBookingsPerMonth:
      values.maxBookingsPerMonth === undefined ? before.maxBookingsPerMonth : values.maxBookingsPerMonth,
  };

  const changed = {
    overnight: after.overnight !== before.overnight,
    duration: after.maxDurationMinutes !== before.maxDurationMinutes,
    day: after.maxBookingsPerDay !== before.maxBookingsPerDay,
    week: after.maxBookingsPerWeek !== before.maxBookingsPerWeek,
    month: after.maxBookingsPerMonth !== before.maxBookingsPerMonth,
  };

  if (
    !actorMayManageGroups &&
    (changed.overnight || changed.day || changed.week || changed.month)
  ) {
    adminOnly("You do not have permission to change a group's booking policies.");
  }

  const problem = groupPolicyProblem(await getAppBookingPolicy(tx), {
    overnight: changed.overnight ? after.overnight : "INHERIT",
    maxDurationMinutes: changed.duration ? after.maxDurationMinutes : null,
    maxBookingsPerDay: changed.day ? after.maxBookingsPerDay : null,
    maxBookingsPerWeek: changed.week ? after.maxBookingsPerWeek : null,
    maxBookingsPerMonth: changed.month ? after.maxBookingsPerMonth : null,
  });

  if (problem) throw new GroupError(problem, 400);

  const row = {
    maxDurationMinutes: values.maxDurationMinutes,
    maxAdvanceDays: values.maxAdvanceDays,
    maxOccurrences: values.maxOccurrences,
    overnightPolicy: after.overnight,
    maxBookingsPerDay: after.maxBookingsPerDay,
    maxBookingsPerWeek: after.maxBookingsPerWeek,
    maxBookingsPerMonth: after.maxBookingsPerMonth,
  };

  await tx
    .insert(groupSettings)
    .values({ groupId, ...row })
    .onConflictDoUpdate({ target: groupSettings.groupId, set: row });

  return { before, after };
}

// A dedicated audit entry whenever a group's booking policy actually changes
// (previous and new values), next to the group's general GROUP_UPDATED entry.
async function auditBookingPolicy(
  tx: Tx,
  actorEmployeeId: number,
  groupId: number,
  { before, after }: { before: GroupBookingPolicy; after: GroupBookingPolicy }
) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;

  await audit(
    tx,
    actorEmployeeId,
    GROUP_AUDIT.BOOKING_POLICY,
    { before, after },
    groupId
  );
}

// Replaces the group's room list. Unknown rooms are rejected, not dropped.
async function writeRooms(tx: Tx, groupId: number, roomIds: number[]) {
  const wanted = [...new Set(roomIds)];

  if (wanted.length > 0) {
    const found = await tx
      .select({ id: room.room_id })
      .from(room)
      .where(inArray(room.room_id, wanted));

    if (found.length !== wanted.length) {
      throw new GroupError("One or more rooms do not exist.", 400);
    }
  }

  await tx.delete(groupRooms).where(eq(groupRooms.groupId, groupId));

  if (wanted.length > 0) {
    await tx
      .insert(groupRooms)
      .values(wanted.map((roomId) => ({ groupId, roomId })));
  }
}

// Every meeting type, for the permission editor and the priority editor.
export async function listMeetingTypes() {
  return db
    .select({
      id: meetingTypes.meetingTypeId,
      name: meetingTypes.meetingTypeName,
      priorityRank: meetingTypes.priorityRank,
    })
    .from(meetingTypes)
    .orderBy(asc(meetingTypes.meetingTypeId));
}

// Sets a meeting type's priority (1 = highest ... 5 = lowest). Rooms are
// compared on the type's CURRENT rank, so this applies at once to meetings
// already booked as well as to new ones; it does not move any booking.
export async function updateMeetingTypePriority(
  meetingTypeId: number,
  priorityRank: number,
  actorEmployeeId: number
) {
  return db.transaction(async (tx) => {
    if (!(await loadActor(tx, actorEmployeeId)).isAdmin) {
      adminOnly("Only an administrator can change meeting type priorities.");
    }

    const [before] = await tx
      .select({
        id: meetingTypes.meetingTypeId,
        name: meetingTypes.meetingTypeName,
        priorityRank: meetingTypes.priorityRank,
      })
      .from(meetingTypes)
      .where(eq(meetingTypes.meetingTypeId, meetingTypeId))
      .for("update");

    if (!before) throw new GroupError("Meeting type not found.", 404);

    if (before.priorityRank === priorityRank) return before;

    await tx
      .update(meetingTypes)
      .set({ priorityRank })
      .where(eq(meetingTypes.meetingTypeId, meetingTypeId));

    await audit(tx, actorEmployeeId, GROUP_AUDIT.MEETING_TYPE_PRIORITY, {
      meetingTypeId,
      name: before.name,
      from: before.priorityRank,
      to: priorityRank,
    });

    return { ...before, priorityRank };
  });
}

// Replaces the group's meeting type list. Unknown ids are rejected, not
// dropped, so a stale form cannot silently save a different list.
async function writeMeetingTypes(tx: Tx, groupId: number, typeIds: number[]) {
  const wanted = [...new Set(typeIds)];

  if (wanted.length > 0) {
    const found = await tx
      .select({ id: meetingTypes.meetingTypeId })
      .from(meetingTypes)
      .where(inArray(meetingTypes.meetingTypeId, wanted));

    if (found.length !== wanted.length) {
      throw new GroupError("One or more meeting types do not exist.", 400);
    }
  }

  await tx.delete(groupMeetingTypes).where(eq(groupMeetingTypes.groupId, groupId));

  if (wanted.length > 0) {
    await tx
      .insert(groupMeetingTypes)
      .values(wanted.map((meetingTypeId) => ({ groupId, meetingTypeId })));
  }
}

async function writePermissions(tx: Tx, groupId: number, enabled: string[]) {
  const on = new Set(enabled);

  await tx
    .insert(groupPermissions)
    .values(
      ALL_PERMISSIONS.map((key) => ({
        groupId,
        permissionKey: key,
        isEnabled: on.has(key),
      }))
    )
    .onConflictDoUpdate({
      target: [groupPermissions.groupId, groupPermissions.permissionKey],
      set: { isEnabled: sql`excluded.is_enabled` },
    });
}

export async function createGroup(
  input: CreateGroupInput,
  actorEmployeeId: number
) {
  try {
    return await db.transaction(async (tx) => {
      // A new group comes with its own priority and permissions.
      if (!(await loadActor(tx, actorEmployeeId)).isAdmin) {
        adminOnly("Only an administrator can create groups.");
      }

      const [created] = await tx
        .insert(groups)
        .values({
          name: input.name,
          description: input.description,
          priority: input.priority,
          isActive: input.isActive,
        })
        .returning();

      await writePermissions(tx, created.id, input.permissions);
      await writeMeetingTypes(tx, created.id, input.meetingTypeIds);
      const policy = await writeSettings(tx, created.id, input.settings, true);
      await writeRooms(tx, created.id, input.roomIds);
      await audit(
        tx,
        actorEmployeeId,
        GROUP_AUDIT.CREATED,
        {
          name: created.name,
          priority: created.priority,
          permissions: input.permissions,
          meetingTypeIds: input.meetingTypeIds,
          settings: input.settings,
          roomIds: input.roomIds,
        },
        created.id
      );
      await auditBookingPolicy(tx, actorEmployeeId, created.id, policy);

      return created;
    });
  } catch (error) {
    return mapConflict(error);
  }
}

export async function updateGroup(
  groupId: number,
  input: UpdateGroupInput,
  actorEmployeeId: number
) {
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(groups)
        .where(eq(groups.id, groupId))
        .for("update");

      if (!before) throw new GroupError("Group not found.", 404);

      const actor = await loadActor(tx, actorEmployeeId);

      if (!actor.isAdmin) {
        // A group with administrative permissions can only be edited by an
        // administrator - except for its booking policies, which anyone who
        // may manage groups can set.
        if (
          (await isPrivilegedGroup(tx, groupId)) &&
          (await changesBeyondSettings(tx, before, input))
        ) {
          adminOnly(
            "Only an administrator can edit a group with administrative permissions."
          );
        }

        if (await changesPermissionsOrPriority(tx, before, input)) {
          adminOnly(
            "Only an administrator can change a group's priority, permissions or meeting types."
          );
        }
      }

      const [after] = await tx
        .update(groups)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          updatedAt: new Date(),
        })
        .where(eq(groups.id, groupId))
        .returning();

      if (input.permissions) {
        await writePermissions(tx, groupId, input.permissions);
      }

      if (input.meetingTypeIds) {
        await writeMeetingTypes(tx, groupId, input.meetingTypeIds);
      }

      let policy: Awaited<ReturnType<typeof writeSettings>> | null = null;

      if (input.settings) {
        policy = await writeSettings(tx, groupId, input.settings, actor.mayManageGroups);
      }

      if (input.roomIds) {
        await writeRooms(tx, groupId, input.roomIds);
      }

      await audit(
        tx,
        actorEmployeeId,
        GROUP_AUDIT.UPDATED,
        {
          before: {
            name: before.name,
            priority: before.priority,
            isActive: before.isActive,
          },
          after: {
            name: after.name,
            priority: after.priority,
            isActive: after.isActive,
          },
          permissions: input.permissions,
          meetingTypeIds: input.meetingTypeIds,
          settings: input.settings,
          roomIds: input.roomIds,
        },
        groupId
      );

      if (policy) await auditBookingPolicy(tx, actorEmployeeId, groupId, policy);

      return after;
    });
  } catch (error) {
    return mapConflict(error);
  }
}

// A group may only be deleted when nothing refers to it. Otherwise it must be
// deactivated: that stops new assignments while keeping history intact.
export async function deleteGroup(groupId: number, actorEmployeeId: number) {
  await db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .for("update");

    if (!group) throw new GroupError("Group not found.", 404);

    if (
      !(await loadActor(tx, actorEmployeeId)).isAdmin &&
      (await isPrivilegedGroup(tx, groupId))
    ) {
      adminOnly(
        "Only an administrator can delete a group with administrative permissions."
      );
    }

    const [{ members }] = await tx
      .select({ members: count() })
      .from(userGroups)
      .where(eq(userGroups.groupId, groupId));

    const [{ bookings }] = await tx
      .select({ bookings: count() })
      .from(meeting)
      .where(eq(meeting.groupIdAtBooking, groupId));

    const [{ history }] = await tx
      .select({ history: count() })
      .from(bookingPriorityHistory)
      .where(
        or(
          eq(bookingPriorityHistory.previousGroupId, groupId),
          eq(bookingPriorityHistory.incomingGroupId, groupId)
        )
      );

    if (members + bookings + history > 0) {
      throw new GroupError(
        "This group has assigned employees or booking history and cannot be deleted. Deactivate it instead.",
        409
      );
    }

    await tx.delete(groups).where(eq(groups.id, groupId));
    await audit(
      tx,
      actorEmployeeId,
      GROUP_AUDIT.DELETED,
      { name: group.name, priority: group.priority },
      groupId
    );
  });
}

/* ----------------------------- assignments ------------------------------- */

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listEmployees(options: {
  search?: string;
  groupId?: number | "none";
  page: number;
  pageSize: number;
}) {
  const term = options.search?.trim();

  const where = and(
    term
      ? or(
          ilike(employee.employee_name, `%${escapeLike(term)}%`),
          ilike(employee.email, `%${escapeLike(term)}%`)
        )
      : undefined,
    options.groupId === "none"
      ? isNull(userGroups.id)
      : options.groupId !== undefined
        ? eq(userGroups.groupId, options.groupId)
        : undefined
  );

  const base = db
    .select({
      employeeId: employee.employee_id,
      name: employee.employee_name,
      email: employee.email,
      role: roles.roleName,
      groupId: groups.id,
      groupName: groups.name,
      priority: groups.priority,
      assignedAt: userGroups.assignedAt,
    })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .leftJoin(
      userGroups,
      and(
        eq(userGroups.employeeId, employee.employee_id),
        isNull(userGroups.effectiveUntil)
      )
    )
    .leftJoin(groups, eq(groups.id, userGroups.groupId))
    .where(where);

  const [{ total }] = await db
    .select({ total: count() })
    .from(employee)
    .leftJoin(
      userGroups,
      and(
        eq(userGroups.employeeId, employee.employee_id),
        isNull(userGroups.effectiveUntil)
      )
    )
    .where(where);

  const rows = await base
    .orderBy(asc(employee.employee_name), asc(employee.employee_id))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);

  return { rows, total };
}

export async function getEmployeeGroupHistory(employeeId: number) {
  return db
    .select({
      id: userGroups.id,
      groupId: groups.id,
      groupName: groups.name,
      priority: groups.priority,
      assignedAt: userGroups.assignedAt,
      effectiveUntil: userGroups.effectiveUntil,
      assignedBy: employee.employee_name,
    })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .leftJoin(employee, eq(employee.employee_id, userGroups.assignedBy))
    .where(eq(userGroups.employeeId, employeeId))
    .orderBy(desc(userGroups.assignedAt), desc(userGroups.id));
}

// Puts the employee in `groupId`, closing any current assignment (history is
// kept). The one-active-group rule is enforced by the partial unique index; the
// row lock on the employee just makes concurrent admin edits queue up cleanly.
export async function assignEmployee(
  employeeId: number,
  groupId: number,
  actorEmployeeId: number
) {
  try {
    return await db.transaction(async (tx) => {
      const [person] = await tx
        .select({ id: employee.employee_id })
        .from(employee)
        .where(eq(employee.employee_id, employeeId))
        .for("update");

      if (!person) throw new GroupError("Employee not found.", 404);

      const [target] = await tx
        .select()
        .from(groups)
        .where(eq(groups.id, groupId))
        .for("share");

      if (!target) throw new GroupError("Group not found.", 404);

      if (!target.isActive) {
        throw new GroupError(
          "This group is inactive and cannot receive new assignments.",
          409
        );
      }

      const [current] = await tx
        .select()
        .from(userGroups)
        .where(
          and(
            eq(userGroups.employeeId, employeeId),
            isNull(userGroups.effectiveUntil)
          )
        );

      if (current?.groupId === groupId) return { changed: false, group: target };

      await assertMayReassign(
        tx,
        await loadActor(tx, actorEmployeeId),
        employeeId,
        current?.groupId ?? null,
        groupId
      );

      if (current) {
        await tx
          .update(userGroups)
          .set({ effectiveUntil: sql`now()` }) // DB clock, like assigned_at
          .where(eq(userGroups.id, current.id));
      }

      await tx.insert(userGroups).values({
        employeeId,
        groupId,
        assignedBy: actorEmployeeId,
      });

      await audit(
        tx,
        actorEmployeeId,
        current ? GROUP_AUDIT.CHANGED : GROUP_AUDIT.ASSIGNED,
        { fromGroupId: current?.groupId ?? null, toGroupId: groupId },
        groupId,
        employeeId
      );

      return { changed: true, group: target };
    });
  } catch (error) {
    return mapConflict(error);
  }
}

// Ends the employee's assignment; they fall back to the default policy.
export async function unassignEmployee(
  employeeId: number,
  actorEmployeeId: number
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(
        and(
          eq(userGroups.employeeId, employeeId),
          isNull(userGroups.effectiveUntil)
        )
      );

    if (current) {
      await assertMayReassign(
        tx,
        await loadActor(tx, actorEmployeeId),
        employeeId,
        current.groupId,
        null
      );
    }

    const closed = await tx
      .update(userGroups)
      .set({ effectiveUntil: sql`now()` }) // DB clock, like assigned_at
      .where(
        and(
          eq(userGroups.employeeId, employeeId),
          isNull(userGroups.effectiveUntil)
        )
      )
      .returning({ groupId: userGroups.groupId });

    if (closed.length === 0) {
      throw new GroupError("The employee has no active group.", 404);
    }

    await audit(
      tx,
      actorEmployeeId,
      GROUP_AUDIT.REMOVED,
      { fromGroupId: closed[0].groupId },
      closed[0].groupId,
      employeeId
    );
  });
}

export async function groupsById(ids: number[]) {
  if (ids.length === 0) return [];

  return db.select().from(groups).where(inArray(groups.id, ids));
}
