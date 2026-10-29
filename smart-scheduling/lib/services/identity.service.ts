import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { employee, organizers, roles } from "@/db/schema";

export type CurrentOrganizer = typeof organizers.$inferSelect & {
  // Role resolved from Employee ⨝ roles right now — never the (possibly
  // stale) copy cached on the Organizer row.
  role: string;
};

// Resolves a signed-in email to the Organizer row plus the *current* Employee
// role. Access is withdrawn immediately when the Employee row is removed or its
// email no longer matches, and a demotion in `Employee.role_id` takes effect on
// the very next request even though the JWT session itself is stateless.
export async function resolveOrganizerByEmail(
  email: string
): Promise<CurrentOrganizer | null> {
  const rows = await db
    .select({
      organizer: organizers,
      role: roles.roleName,
    })
    .from(organizers)
    .innerJoin(employee, eq(employee.employee_id, organizers.employeeId))
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(and(eq(organizers.email, email), eq(employee.email, email)))
    .limit(1);

  if (rows.length === 0) return null;

  return { ...rows[0].organizer, role: rows[0].role };
}
