"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  House,
  CalendarPlus,
  Building2,
  ClipboardList,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const menus = [
  {
    title: "Home",
    href: "/home",
    icon: House,
  },
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
  {
    title: "Room Requests",
    href: "/requests",
    icon: Inbox,
  },
];

type Props = {
  // Icons only, to give the page more room.
  collapsed?: boolean;
  onToggle: () => void;
};

export default function BookingSidebar({ collapsed = false, onToggle }: Props) {
  const pathname = usePathname();

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r bg-white transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-64"
      }`}
      aria-label="Navigation"
    >

      {/* Collapse / expand, at the top of the sidebar. */}

      <div
        className={`flex border-b p-3 ${
          collapsed ? "justify-center" : "justify-end"
        }`}
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

      <nav className="flex-1 space-y-2 overflow-y-auto p-3">

        {!collapsed && (
          <h2 className="px-2 pb-2 pt-1 text-lg font-bold text-blue-700">
            Navigation
          </h2>
        )}

        {menus.map((menu) => {

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
                className={`mb-2 h-12 w-full ${
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
