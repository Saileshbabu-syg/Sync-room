import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { eq } from "drizzle-orm";

import { db } from "@/app/db";
import { employees, organizers } from "@/app/db/schema";

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
        // Check Employee table
        const employee = await db
          .select()
          .from(employees)
          .where(eq(employees.email, user.email!));

        // Employee not found
        if (employee.length === 0) {
                return "/login?error=not-authorized";
        }

        const employeeId = employee[0].employeeId;
        const role = employee[0].role;

        // Check Organizer already exists
        const existingOrganizer = await db
          .select()
          .from(organizers)
          .where(eq(organizers.email, user.email!));

        // Create Organizer if not exists
        if (existingOrganizer.length === 0) {
          await db.insert(organizers).values({
            employeeId: employeeId,
            name: user.name!,
            email: user.email!,
            imageUrl: user.image ?? null,
            role: role,
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