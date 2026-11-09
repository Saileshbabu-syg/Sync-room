"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

import {
  House,
  CalendarPlus,
  Building2,
  ClipboardList,
  UsersRound,
  BarChart3,
  PanelLeftClose,
  PanelLeftOpen,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const homeMenu = {
  title: "Home",
  href: "/home",
  icon: House,
};

const menus = [
  {
    title: "Book Meeting",
    href: "/booking",
    icon: CalendarPlus,
  },
  {
    title: "Rooms",
    href: "/rooms",
    icon: Building2,
  },
  {
    title: "My Bookings",
    href: "/bookings",
    icon: ClipboardList,
  },
];

// Shown only to people who may use them (the pages and APIs enforce it again).
const groupManagementMenu = {
  title: "Group Management",
  href: "/admin/groups",
  icon: UsersRound,
};

const dashboardMenu = {
  title: "Dashboard",
  href: "/dashboard",
  icon: BarChart3,
};

type MenuOptions = {
  showGroupManagement?: boolean;
  showBookingDashboard?: boolean;
};

// A spinner on the link being opened until the page arrives (pages are
// rendered on the server, so a click can take a moment).
function Pending({ collapsed }: { collapsed: boolean }) {
  const { pending } = useLinkStatus();

  if (!pending) return null;

  return (
    <Loader2
      className={`h-4 w-4 animate-spin ${collapsed ? "absolute right-1 top-1 h-3 w-3" : "ml-auto"}`}
      aria-hidden
    />
  );
}

// The menu itself, shared by the sidebar (desktop) and the drawer (phones).
export function NavLinks({
  collapsed = false,
  showGroupManagement = false,
  showBookingDashboard = false,
  onNavigate,
}: MenuOptions & {
  collapsed?: boolean;
  // Called when a link is followed (the drawer closes itself).
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  // Dashboard sits directly under Home.
  const visibleMenus = [
    homeMenu,
    ...(showBookingDashboard ? [dashboardMenu] : []),
    ...menus,
    ...(showGroupManagement ? [groupManagementMenu] : []),
  ];

  return (
    <nav
      className="flex-1 space-y-1 overflow-y-auto border-t p-2"
      aria-label="Main"
    >

      {visibleMenus.map((menu) => {

        const Icon = menu.icon;

        // Nested pages (/bookings/5) keep their section highlighted.
        const active =
          pathname === menu.href || pathname.startsWith(`${menu.href}/`);

        // One focusable element per entry: the link, styled as a button.
        return (
          <Button
            key={menu.title}
            asChild
            variant={active ? "default" : "ghost"}
            className={`relative h-10 w-full ${
              collapsed ? "justify-center px-0" : "justify-start"
            }`}
          >
            <Link
              href={menu.href}
              title={collapsed ? menu.title : undefined}
              aria-label={collapsed ? menu.title : undefined}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
            >

              <Icon className={collapsed ? "h-5 w-5" : "mr-3 h-5 w-5"} aria-hidden />

              {!collapsed && menu.title}

              <Pending collapsed={collapsed} />

            </Link>
          </Button>
        );
      })}

    </nav>
  );
}

type Props = MenuOptions & {
  // Icons only, to give the page more room.
  collapsed?: boolean;
  onToggle: () => void;
};

// The desktop sidebar (md and up; phones use the drawer in AppShell).
export default function BookingSidebar({
  collapsed = false,
  onToggle,
  showGroupManagement = false,
  showBookingDashboard = false,
}: Props) {
  return (
    <aside
      className={`hidden h-full shrink-0 flex-col border-r bg-white transition-[width] duration-200 md:flex ${
        collapsed ? "w-16" : "w-64"
      }`}
      aria-label="Navigation"
    >

      {/* Collapse / expand, on the left of the navigation header. */}

      <div
        className={`flex p-2 ${collapsed ? "justify-center" : "justify-start"}`}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-5 w-5" />
          ) : (
            <PanelLeftClose className="h-5 w-5" />
          )}
        </Button>
      </div>

      <NavLinks
        collapsed={collapsed}
        showGroupManagement={showGroupManagement}
        showBookingDashboard={showBookingDashboard}
      />

      {/* Footer */}

      {!collapsed && (
        <div className="border-t p-4">

          <p className="text-center text-xs text-gray-500">
            Smart Scheduling
          </p>

        </div>
      )}

    </aside>
  );
}
