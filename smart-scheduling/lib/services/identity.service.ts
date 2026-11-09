import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { employee, organizers, roles } from "@/db/schema";

export type CurrentOrganizer = typeof organizers.$inferSelect & {
  // Role resolved from Employee ⨝ roles right now — never the (possibly
  // stale) copy cached on the Organizer row.
  role: string;
};

// E-mails are compared case-insensitively everywhere (the directory, Google
// and hand-entered rows do not agree on case).
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

// Resolves a signed-in email to the Organizer row plus the *current* Employee
// role. Access is withdrawn immediately when the Employee row is removed or
// deactivated or its email no longer matches, and a demotion in
// `Employee.role_id` takes effect on the very next request even though the JWT
// session itself is stateless.
export async function resolveOrganizerByEmail(
  email: string
): Promise<CurrentOrganizer | null> {
  const normalized = normalizeEmail(email);

  const rows = await db
    .select({
      organizer: organizers,
      role: roles.roleName,
    })
    .from(organizers)
    .innerJoin(employee, eq(employee.employee_id, organizers.employeeId))
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(
      and(
        sql`lower(${organizers.email}) = ${normalized}`,
        sql`lower(${employee.email}) = ${normalized}`,
        eq(employee.is_active, true)
      )
    )
    .limit(1);

  if (rows.length === 0) return null;

  return { ...rows[0].organizer, role: rows[0].role };
}

// Why a sign-in was refused. The codes are what /login shows a message for;
// none of them says whether the e-mail exists, is inactive or is unverified
// beyond what the person already knows from their Google account.
export type SignInRefusal = "not-authorized" | "unverified-email" | "server-error";

export type SignInAttempt = {
  email: string | null | undefined;
  // Whether the identity provider vouches for the address (Google's
  // `email_verified`). Anything but true is refused.
  emailVerified: boolean;
  name: string | null | undefined;
  image: string | null | undefined;
};

// The sign-in gate: the address must be verified by the provider and belong to
// an ACTIVE Employee row (matched case-insensitively). On success the cached
// Organizer row is created or refreshed. Returns true or the refusal code.
export async function authorizeSignIn(
  attempt: SignInAttempt
): Promise<true | SignInRefusal> {
  if (!attempt.email) return "not-authorized";

  if (!attempt.emailVerified) return "unverified-email";

  const email = normalizeEmail(attempt.email);

  try {
    const matches = await db
      .select({
        employeeId: employee.employee_id,
        role: roles.roleName,
        isActive: employee.is_active,
      })
      .from(employee)
      .innerJoin(roles, eq(employee.role_id, roles.roleId))
      .where(sql`lower(${employee.email}) = ${email}`)
      .limit(2);

    // Two rows differing only in case: refuse rather than guess who it is.
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.error("Sign-in refused: several Employee rows share one e-mail.");
      }

      return "not-authorized";
    }

    const [match] = matches;

    if (!match.isActive) return "not-authorized";

    const [existing] = await db
      .select()
      .from(organizers)
      .where(sql`lower(${organizers.email}) = ${email}`)
      .limit(1);

    // Keep the cached Organizer copy in step with the Employee record.
    // (Authorization never reads this copy — it resolves the role from
    // Employee on every request — but the UI and reports still show it.)
    if (!existing) {
      await db.insert(organizers).values({
        employeeId: match.employeeId,
        name: attempt.name || email,
        email,
        imageUrl: attempt.image ?? null,
        role: match.role,
        provider: "google",
      });
    } else if (
      existing.role !== match.role ||
      existing.employeeId !== match.employeeId ||
      existing.email !== email
    ) {
      await db
        .update(organizers)
        .set({
          role: match.role,
          employeeId: match.employeeId,
          email,
          updatedAt: new Date(),
        })
        .where(eq(organizers.organizerId, existing.organizerId));
    }

    return true;
  } catch (error) {
    // Logged for operators; the person only sees a generic message.
    console.error(
      "Sign-in check failed:",
      error instanceof Error ? error.message : "unknown error"
    );

    return "server-error";
  }
}
