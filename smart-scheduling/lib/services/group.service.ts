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
import { ALL_PERMISSIONS } from "@/lib/constants";
import type { Tx } from "@/lib/db-types";
import type {
  CreateGroupInput,
  UpdateGroupInput,
} from "@/lib/validations/group.validator";

// Admin-side management of application groups, their permissions and the
// employee -> group assignments. Everything here lives in OUR database; Entra /
// Google only identify the employee. Callers (the API routes) must already have
// checked that the actor is an Admin; the actor id is only used for the audit
// trail.

export const GROUP_AUDIT = {
  CREATED: "GROUP_CREATED",
  UPDATED: "GROUP_UPDATED",
  DELETED: "GROUP_DELETED",
  ASSIGNED: "EMPLOYEE_ASSIGNED",
  CHANGED: "EMPLOYEE_GROUP_CHANGED",
  REMOVED: "EMPLOYEE_UNASSIGNED",
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
    },
    // Empty = every room.
    roomIds: rooms.filter((r) => r.groupId === g.id).map((r) => r.roomId),
  }));
}

// Every room, for the room picker.
export async function listRoomOptions() {
  return db
    .select({ id: room.room_id, name: room.room_name })
    .from(room)
    .orderBy(asc(room.room_name));
}

async function writeSettings(
  tx: Tx,
  groupId: number,
  values: {
    maxDurationMinutes: number | null;
    maxAdvanceDays: number | null;
    maxOccurrences: number | null;
  }
) {
  await tx
    .insert(groupSettings)
    .values({ groupId, ...values })
    .onConflictDoUpdate({ target: groupSettings.groupId, set: values });
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

// Every meeting type, for the permission editor (reuses the existing list).
export async function listMeetingTypes() {
  return db
    .select({
      id: meetingTypes.meetingTypeId,
      name: meetingTypes.meetingTypeName,
    })
    .from(meetingTypes)
    .orderBy(asc(meetingTypes.meetingTypeId));
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
      await writeSettings(tx, created.id, input.settings);
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

      if (input.settings) {
        await writeSettings(tx, groupId, input.settings);
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

      if (current) {
        await tx
          .update(userGroups)
          .set({ effectiveUntil: new Date() })
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
    const closed = await tx
      .update(userGroups)
      .set({ effectiveUntil: new Date() })
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
