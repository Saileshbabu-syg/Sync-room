"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  House,
  CalendarPlus,
  Building2,
  ClipboardList,
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
];

export default function BookingSidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-full w-64 flex-col border-r bg-white">

      {/* Sidebar Header */}

      <div className="flex items-center justify-between border-b p-5">

        <h2 className="text-lg font-bold text-blue-700">
          Navigation
        </h2>

      </div>

      {/* Menu */}

      <nav className="flex-1 space-y-2 p-4">

        {menus.map((menu) => {

          const Icon = menu.icon;

          const active = pathname === menu.href;

          return (

            <Link
              key={menu.title}
              href={menu.href}
            >

              <Button
                variant={active ? "default" : "ghost"}
                className="mb-2 h-12 w-full justify-start"
              >

                <Icon className="mr-3 h-5 w-5" />

                {menu.title}

              </Button>

            </Link>

          );
        })}

      </nav>

      {/* Footer */}

      <div className="border-t p-4">

        <p className="text-center text-xs text-gray-500">
          Smart Scheduling
        </p>

      </div>

    </aside>
  );
}