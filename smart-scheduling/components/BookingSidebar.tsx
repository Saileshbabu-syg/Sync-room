"use client";

import Link from "next/link";
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

type Props = {
  // Icons only, to give the page more room.
  collapsed?: boolean;
  onToggle: () => void;
  showGroupManagement?: boolean;
  showBookingDashboard?: boolean;
};

export default function BookingSidebar({
  collapsed = false,
  onToggle,
  showGroupManagement = false,
  showBookingDashboard = false,
}: Props) {
  const pathname = usePathname();

  // Dashboard sits directly under Home.
  const visibleMenus = [
    homeMenu,
    ...(showBookingDashboard ? [dashboardMenu] : []),
    ...menus,
    ...(showGroupManagement ? [groupManagementMenu] : []),
  ];

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r bg-white transition-[width] duration-200 ${
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

      {/* Menu */}

      <nav
        className="flex-1 space-y-1 overflow-y-auto border-t p-2"
        aria-label="Main"
      >

        {visibleMenus.map((menu) => {

          const Icon = menu.icon;

          // Nested pages (/bookings/5) keep their section highlighted.
          const active =
            pathname === menu.href || pathname.startsWith(`${menu.href}/`);

          return (

            <Link
              key={menu.title}
              href={menu.href}
              title={collapsed ? menu.title : undefined}
              aria-label={menu.title}
              aria-current={active ? "page" : undefined}
            >

              <Button
                variant={active ? "default" : "ghost"}
                className={`h-10 w-full ${
                  collapsed ? "justify-center px-0" : "justify-start"
                }`}
                tabIndex={-1}
              >

                <Icon className={collapsed ? "h-5 w-5" : "mr-3 h-5 w-5"} />

                {!collapsed && menu.title}

              </Button>

            </Link>

          );
        })}

      </nav>

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
