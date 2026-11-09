import { NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { jsonError } from "@/lib/api";
import { ROLE_ADMIN, type PermissionKey } from "@/lib/constants";
import type { CurrentOrganizer } from "@/lib/services/identity.service";
import {
  canManageGroups,
  getPriorityContext,
} from "@/lib/services/group-context.service";

// Backend authorization for the group features. Everything is re-read from the
// database on each call (role from Employee, group and permissions from the
// group tables); nothing the client sends is trusted.

export type Guarded =
  | { ok: true; organizer: CurrentOrganizer }
  | { ok: false; response: NextResponse };

// Signed in, and allowed to use Group Management (re-read from the database on
// every call; the screen and the navigation hide it as a convenience only).
export async function requireGroupManagement(): Promise<Guarded> {
  const organizer = await getCurrentOrganizer();

  if (!organizer) {
    return { ok: false, response: jsonError(401, "Unauthorized") };
  }

  if (!(await canManageGroups(organizer.employeeId, organizer.role))) {
    return {
      ok: false,
      response: jsonError(403, "You do not have permission to manage groups."),
    };
  }

  return { ok: true, organizer };
}

// Signed in with the Admin role (re-read from the database on every call).
export async function requireAdmin(): Promise<Guarded> {
  const organizer = await getCurrentOrganizer();

  if (!organizer) {
    return { ok: false, response: jsonError(401, "Unauthorized") };
  }

  if (organizer.role !== ROLE_ADMIN) {
    return {
      ok: false,
      response: jsonError(403, "Only an administrator can do this."),
    };
  }

  return { ok: true, organizer };
}

// Signed in, and the employee's current group (or the default policy) grants
// `key`.
export async function requirePermission(key: PermissionKey): Promise<Guarded> {
  const organizer = await getCurrentOrganizer();

  if (!organizer) {
    return { ok: false, response: jsonError(401, "Unauthorized") };
  }

  const context = await getPriorityContext(organizer.employeeId);

  if (!context.permissions.has(key)) {
    return {
      ok: false,
      response: jsonError(403, "You do not have permission to do this."),
    };
  }

  return { ok: true, organizer };
}
