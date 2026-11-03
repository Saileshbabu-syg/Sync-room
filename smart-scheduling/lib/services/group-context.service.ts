import { and, eq, isNull, max } from "drizzle-orm";

import { db } from "@/db";
import { groupPermissions, groups, userGroups } from "@/db/schema";
import {
  DEFAULT_PERMISSIONS,
  FALLBACK_PRIORITY,
  PERMISSION,
  ROLE_ADMIN,
  type PermissionKey,
} from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";

// What the backend knows about an employee's standing, read from the database
// on every call - never from the session or the request body.
export type PriorityContext = {
  // Null when the employee has no usable group (none, or a deactivated one).
  groupId: number | null;
  groupName: string | null;
  // 1 = highest. Unassigned employees rank as the lowest active group.
  priority: number;
  permissions: Set<string>;
  // Whether this employee's priority may preempt lower-priority bookings.
  canPreempt: boolean;
};

// Priority of an employee with no usable group: that of the LOWEST active
// group, so they never outrank anyone who has been placed in a group.
export async function defaultPriority(executor: DbExecutor = db) {
  const [row] = await executor
    .select({ lowest: max(groups.priority) })
    .from(groups)
    .where(eq(groups.isActive, true));

  return row?.lowest ?? FALLBACK_PRIORITY;
}

export async function getPriorityContext(
  employeeId: number,
  executor: DbExecutor = db
): Promise<PriorityContext> {
  const [membership] = await executor
    .select({
      groupId: groups.id,
      groupName: groups.name,
      priority: groups.priority,
    })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(
      and(
        eq(userGroups.employeeId, employeeId),
        isNull(userGroups.effectiveUntil),
        eq(groups.isActive, true)
      )
    );

  if (!membership) {
    return {
      groupId: null,
      groupName: null,
      priority: await defaultPriority(executor),
      permissions: new Set<string>(DEFAULT_PERMISSIONS),
      // The default policy never preempts anybody.
      canPreempt: false,
    };
  }

  const rows = await executor
    .select({ key: groupPermissions.permissionKey })
    .from(groupPermissions)
    .where(
      and(
        eq(groupPermissions.groupId, membership.groupId),
        eq(groupPermissions.isEnabled, true)
      )
    );

  const permissions = new Set(rows.map((r) => r.key));

  return {
    ...membership,
    permissions,
    canPreempt: permissions.has(PERMISSION.BOOKING_PRIORITY),
  };
}

export async function hasPermission(
  employeeId: number,
  key: PermissionKey,
  executor: DbExecutor = db
) {
  return (await getPriorityContext(employeeId, executor)).permissions.has(key);
}

// Whether this person may use Group Management right now. The Admin ROLE always
// may, so a mistaken permission change can never lock every administrator out;
// anyone else needs their group to grant `group.manage`.
export async function canManageGroups(
  employeeId: number,
  role: string,
  executor: DbExecutor = db
) {
  if (role === ROLE_ADMIN) return true;

  const context = await getPriorityContext(employeeId, executor);

  return context.permissions.has(PERMISSION.GROUP_MANAGE);
}

// Whether this person may create, edit or delete rooms. Same rule as Group
// Management: the Admin role always may, anyone else needs `rooms.manage`.
export async function canManageRooms(
  employeeId: number,
  role: string,
  executor: DbExecutor = db
) {
  if (role === ROLE_ADMIN) return true;

  const context = await getPriorityContext(employeeId, executor);

  return context.permissions.has(PERMISSION.ROOMS_MANAGE);
}
