import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { employee } from "@/db/schema";
import { organizers } from "@/db/schema";
import { roles } from "@/db/schema";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],

  callbacks: {
    async signIn({ user }) {
      try {
        // Check Employee table and fetch role from Roles table
        const employeeData = await db
          .select({
            employeeId: employee.employee_id,
            role: roles.roleName,
          })
          .from(employee)
          .innerJoin(
            roles,
            eq(employee.role_id, roles.roleId)
          )
          .where(eq(employee.email, user.email!));

        // Employee not found
        if (employeeData.length === 0) {
          return "/login?error=not-authorized";
        }

        const employeeId = employeeData[0].employeeId;
        const role = employeeData[0].role;

        // Check if Organizer already exists
        const existingOrganizer = await db
          .select()
          .from(organizers)
          .where(eq(organizers.email, user.email!));

        // Keep the cached Organizer copy in step with the Employee record.
        // (Authorization never reads this copy — it resolves the role from
        // Employee on every request — but the UI and reports still show it.)
        if (
          existingOrganizer.length > 0 &&
          (existingOrganizer[0].role !== role ||
            existingOrganizer[0].employeeId !== employeeId)
        ) {
          await db
            .update(organizers)
            .set({ role, employeeId, updatedAt: new Date() })
            .where(eq(organizers.email, user.email!));
        }

        // Create Organizer if not exists
        if (existingOrganizer.length === 0) {
          await db.insert(organizers).values({
            employeeId,
            name: user.name!,
            email: user.email!,
            imageUrl: user.image ?? null,
            role,
            provider: "google",
          });
        }

        return true;
      } catch (error) {
        console.error("Organizer Insert Error:", error);
        return "/login?error=server-error";
      }
    },
  },
});