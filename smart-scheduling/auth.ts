import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { capSessionAge, SESSION_MAX_AGE_SECONDS } from "@/lib/auth-config";
import { authorizeSignIn } from "@/lib/services/identity.service";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],

  // Stateless JWT session: expires after 12 hours idle (Auth.js re-signs it on
  // use) and, through the jwt callback, 12 hours after sign-in at the latest.
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },

  // Auth.js errors (e.g. ?error=AccessDenied, Configuration) land on our own
  // login page, which maps them to readable messages.
  pages: { signIn: "/login", error: "/login" },

  callbacks: {
    // Only verified addresses of ACTIVE employees get in (see
    // authorizeSignIn); anyone else goes back to /login with an error code.
    async signIn({ user, profile }) {
      const result = await authorizeSignIn({
        email: user.email,
        emailVerified: profile?.email_verified === true,
        name: user.name,
        image: user.image,
      });

      return result === true ? true : `/login?error=${result}`;
    },

    async jwt({ token, account }) {
      return capSessionAge(token, Boolean(account));
    },
  },
});
