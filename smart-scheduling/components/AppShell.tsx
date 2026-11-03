"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Session } from "next-auth";

import BackButton from "@/components/BackButton";
import BookingSidebar from "@/components/BookingSidebar";
import UserSheet from "@/components/UserSheet";

type UserProfile = {
  organizerId: number;
  employeeId: number;
  name: string;
  email: string;
  role: string;
  imageUrl: string | null;
  isAdmin: boolean;
  canManageGroups: boolean;
  canManageRooms: boolean;
  canViewBookingDashboard: boolean;
};

type Props = {
  children: ReactNode;
  session: Session;
  userProfile: UserProfile;
};

const STORAGE_KEY = "sidebarCollapsed";

// Where the Back button (always at the left, above the page) goes. `href`
// pins a parent page; without it the button goes back in the history. Top-level
// pages and the booking success page have no Back button.
function backTarget(pathname: string): { href?: string } | null {
  if (/^\/bookings\/[^/]+$/.test(pathname)) return { href: "/bookings" };
  if (pathname === "/booking/success") return null;

  const depth = pathname.split("/").filter(Boolean).length;

  return depth >= 2 ? {} : null;
}

// The signed-in frame: header + sidebar. It lives in app/(app)/layout.tsx, so
// Next.js keeps it mounted while only the page content changes - the sidebar
// never reloads and remembers whether it is collapsed.
export default function AppShell({ children, session, userProfile }: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Restore the saved choice after mount (storage is not available during
  // server rendering, and may be blocked in the browser).
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      /* keep the default */
    }
  }, []);

  const toggle = () => {
    setCollapsed((current) => {
      const next = !current;

      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* the choice just is not remembered */
      }

      return next;
    });
  };

  // The home page is a full-width landing page with its own sections; every
  // other page sits in a card.
  const fullWidth = pathname === "/home";
  const back = backTarget(pathname);

  return (
    <div className="flex h-screen flex-col bg-slate-100">
      <header className="z-40 border-b bg-white shadow-sm">
        <div className="flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-bold text-blue-700">MeetSched</h1>

              <p className="hidden text-sm text-gray-500 sm:block">
                Smart Meeting Scheduling Platform
              </p>
            </div>
          </div>

          <UserSheet session={session} userProfile={userProfile} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <BookingSidebar
          collapsed={collapsed}
          onToggle={toggle}
          showGroupManagement={userProfile.canManageGroups}
          showBookingDashboard={userProfile.canViewBookingDashboard}
        />

        <main className="min-w-0 flex-1 overflow-y-auto">
          {fullWidth ? (
            children
          ) : (
            <div className="p-8">
              <div className="rounded-3xl bg-white p-8 shadow-sm">
                {back && (
                  <div className="mb-6 flex justify-start">
                    <BackButton href={back.href} />
                  </div>
                )}

                {children}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
