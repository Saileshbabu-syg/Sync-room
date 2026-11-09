import Link from "next/link";

import {
  CalendarPlus,
  Building2,
  ClipboardList,
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

// Each card is a real link: reachable with Tab, opened with Enter, can be
// opened in a new tab, and announced as a link by screen readers.
export default function QuickActions() {
  return (
    <section className="mx-auto mt-12 max-w-7xl px-4 sm:px-6">

      <div className="mb-8">

        <h2 className="text-2xl font-bold text-slate-800 sm:text-3xl">
          Quick Actions
        </h2>

        <p className="mt-2 text-gray-500">
          Choose an action to continue.
        </p>

      </div>

      <ul className="grid gap-6 md:grid-cols-3">

        {actions.map((action) => {

          const Icon = action.icon;

          return (

            <li key={action.title}>

              <Link
                href={action.route}
                className="group block h-full rounded-3xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/50"
              >

                <Card className="h-full rounded-3xl border-0 shadow-md transition-all duration-300 group-hover:-translate-y-2 group-hover:shadow-xl group-focus-visible:-translate-y-2 group-focus-visible:shadow-xl">

                  <CardContent className="p-6 sm:p-8">

                    <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100">

                      <Icon className="h-7 w-7 text-blue-700" aria-hidden />

                    </div>

                    <h3 className="text-xl font-semibold">

                      {action.title}

                    </h3>

                    <p className="mt-3 text-sm leading-6 text-gray-500">

                      {action.description}

                    </p>

                    <div className="mt-6 flex items-center gap-2 font-medium text-blue-700" aria-hidden>

                      Open

                      <ArrowRight className="h-4 w-4" />

                    </div>

                  </CardContent>

                </Card>

              </Link>

            </li>

          );
        })}

      </ul>

    </section>
  );
}
