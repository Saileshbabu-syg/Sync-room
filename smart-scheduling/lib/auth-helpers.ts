import { auth } from "@/auth";
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

  return {
    organizerId: organizer.organizerId,
    employeeId: organizer.employeeId,
    name: organizer.name,
    email: organizer.email,
    role: organizer.role,
    imageUrl: organizer.imageUrl,
  };
}
