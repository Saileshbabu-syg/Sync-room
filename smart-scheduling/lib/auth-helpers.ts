import { auth } from "@/auth";
import { PERMISSION, ROLE_ADMIN } from "@/lib/constants";

import {
  canManageGroups,
  canManageRooms,
  getPriorityContext,
} from "@/lib/services/group-context.service";
import {
  resolveOrganizerByEmail,
  type CurrentOrganizer,
} from "@/lib/services/identity.service";

// Resolves the signed-in session to its Organizer row (employeeId + role),
// so route handlers can authorize by identity instead of trusting any
// employee/organizer id the client sends in the request body.
//
// The role is looked up from the Employee record on every call, so a
// demoted or offboarded user loses access without having to sign in again.
export async function getCurrentOrganizer(): Promise<CurrentOrganizer | null> {
  const session = await auth();

  if (!session?.user?.email) {
    return null;
  }

  return resolveOrganizerByEmail(session.user.email);
}

// Same identity, shaped for the layout components (`userProfile`).
export async function getCurrentUserProfile() {
  const organizer = await getCurrentOrganizer();

  if (!organizer) {
    return null;
  }

  // Navigation visibility only. Every protected API and page re-checks this
  // on the server; hiding a tab is never the access control.
  const standing = await getPriorityContext(organizer.employeeId);

  return {
    isAdmin: organizer.role === ROLE_ADMIN,
    canManageGroups: await canManageGroups(
      organizer.employeeId,
      organizer.role
    ),
    canManageRooms: await canManageRooms(organizer.employeeId, organizer.role),
    canViewBookingDashboard: standing.permissions.has(PERMISSION.DASHBOARD_VIEW),
    organizerId: organizer.organizerId,
    employeeId: organizer.employeeId,
    name: organizer.name,
    email: organizer.email,
    role: organizer.role,
    imageUrl: organizer.imageUrl,
  };
}
