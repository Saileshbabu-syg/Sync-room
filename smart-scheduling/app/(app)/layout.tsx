import { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";

import AppShell from "@/components/AppShell";

// Every signed-in page shares this frame. It is rendered once and kept while
// the user navigates, so the sidebar stays put (and collapsed or expanded).
// Pages still check the session themselves: a layout is not re-run on
// client-side navigation, so it cannot be the only guard.
export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();

  if (!session) redirect("/login");

  const userProfile = await getCurrentUserProfile();

  // Signed in, but no longer a known employee: treat as signed out.
  if (!userProfile) redirect("/login");

  return (
    <AppShell session={session} userProfile={userProfile}>
      {children}
    </AppShell>
  );
}
