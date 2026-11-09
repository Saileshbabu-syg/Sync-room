"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Session } from "next-auth";
import { Menu } from "lucide-react";

import BackButton from "@/components/BackButton";
import BookingSidebar, { NavLinks } from "@/components/BookingSidebar";
import UserSheet from "@/components/UserSheet";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

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
  // The navigation drawer on phones (below md the sidebar is hidden).
  const [menuOpen, setMenuOpen] = useState(false);

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

  // The drawer is only for narrow screens: close it when the window grows wide
  // enough for the sidebar (otherwise its overlay would stay behind).
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (wide.matches) setMenuOpen(false);
    };

    wide.addEventListener("change", onChange);

    return () => wide.removeEventListener("change", onChange);
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
        <div className="flex h-16 items-center justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMenuOpen(true)}
              aria-label="Open navigation"
              aria-expanded={menuOpen}
              data-testid="mobile-nav-toggle"
            >
              <Menu className="h-5 w-5" />
            </Button>

            <div className="min-w-0">
              <h1 className="text-xl font-bold text-blue-700 sm:text-2xl">MeetSched</h1>

              <p className="hidden text-sm text-gray-500 sm:block">
                Smart Meeting Scheduling Platform
              </p>
            </div>
          </div>

          <UserSheet session={session} userProfile={userProfile} />
        </div>
      </header>

      {/* Phones: the same menu in a drawer. Escape, the X or a tap outside
          close it, and so does following a link. */}
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0 md:hidden">
          <SheetHeader className="border-b">
            <SheetTitle className="text-lg font-bold text-blue-700">MeetSched</SheetTitle>
            <SheetDescription>Navigation</SheetDescription>
          </SheetHeader>

          <NavLinks
            showGroupManagement={userProfile.canManageGroups}
            showBookingDashboard={userProfile.canViewBookingDashboard}
            onNavigate={() => setMenuOpen(false)}
          />
        </SheetContent>
      </Sheet>

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
            <div className="p-3 sm:p-6 lg:p-8">
              <div className="rounded-3xl bg-white p-4 shadow-sm sm:p-6 lg:p-8">
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
