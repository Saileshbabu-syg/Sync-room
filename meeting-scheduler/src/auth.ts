import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { eq } from "drizzle-orm";

import { db } from "@/app/db";
import { organizers } from "@/app/db/schema";

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
        const existingOrganizer = await db
          .select()
          .from(organizers)
          .where(eq(organizers.email, user.email!));

        if (existingOrganizer.length === 0) {
          await db.insert(organizers).values({
            name: user.name!,
            email: user.email!,
            imageUrl: user.image!,
            roleId: 2,
          });
        }

        return true;
      } catch (error) {
        console.error("Organizers Insert Error:", error);
        return false;
      }
    },
  },
});