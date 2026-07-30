"use client";

import { useRouter } from "next/navigation";

import {
  CalendarPlus,
  Building2,
  ClipboardList,
  Info,
  ArrowRight,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

const actions = [
  {
    title: "Book Meeting",
    description:
      "Schedule a new meeting room quickly.",
    icon: CalendarPlus,
    route: "/booking",
  },
  {
    title: "All Rooms",
    description:
      "View all meeting rooms and facilities.",
    icon: Building2,
    route: "/rooms",
  },
  {
    title: "My Bookings",
    description:
      "View, edit and cancel your bookings.",
    icon: ClipboardList,
    route: "/bookings",
  },
];

export default function QuickActions() {
  const router = useRouter();

  return (
    <section className="mx-auto mt-12 max-w-7xl px-6">

      <div className="mb-8">

        <h2 className="text-3xl font-bold text-slate-800">
          Quick Actions
        </h2>

        <p className="mt-2 text-gray-500">
          Choose an action to continue.
        </p>

      </div>

      <div className="grid gap-6 md:grid-cols-3">

        {actions.map((action) => {

          const Icon = action.icon;

          return (

            <Card
              key={action.title}
              onClick={() => router.push(action.route)}
              className="cursor-pointer rounded-3xl border-0 shadow-md transition-all duration-300 hover:-translate-y-2 hover:shadow-xl"
            >

              <CardContent className="p-8">

                <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100">

                  <Icon className="h-7 w-7 text-blue-700" />

                </div>

                <h3 className="text-xl font-semibold">

                  {action.title}

                </h3>

                <p className="mt-3 text-sm leading-6 text-gray-500">

                  {action.description}

                </p>

                <div className="mt-6 flex items-center gap-2 font-medium text-blue-700">

                  Open

                  <ArrowRight className="h-4 w-4" />

                </div>

              </CardContent>

            </Card>

          );
        })}

      </div>

    </section>
  );
}