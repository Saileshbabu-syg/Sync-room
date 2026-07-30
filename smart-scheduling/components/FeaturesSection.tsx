"use client";

import {
  CalendarDays,
  Building2,
  ClipboardCheck,
  MailCheck,
} from "lucide-react";

const features = [
  {
    icon: CalendarDays,
    title: "Easy Booking",
    description:
      "Reserve meeting rooms in just a few clicks.",
    color: "text-blue-600 bg-blue-100",
  },
  {
    icon: Building2,
    title: "Room Availability",
    description:
      "Check available rooms instantly.",
    color: "text-green-600 bg-green-100",
  },
  {
    icon: ClipboardCheck,
    title: "Manage Meetings",
    description:
      "View, edit and cancel your bookings.",
    color: "text-purple-600 bg-purple-100",
  },
  {
    icon: MailCheck,
    title: "Email Notifications",
    description:
      "Receive instant confirmation and reminder emails.",
    color: "text-orange-600 bg-orange-100",
  },
];

export default function FeaturesSection() {
  return (
    <section className="mx-auto mt-12 mb-14 max-w-7xl px-6">

      <h2 className="mb-8 text-3xl font-bold">
        Why Choose MeetSched?
      </h2>

      <div className="grid gap-5 md:grid-cols-2">

        {features.map((feature) => {

          const Icon = feature.icon;

          return (

            <div
              key={feature.title}
              className="flex items-start gap-5 rounded-2xl border bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg"
            >

              <div
                className={`flex h-14 w-14 items-center justify-center rounded-xl ${feature.color}`}
              >
                <Icon className="h-7 w-7" />
              </div>

              <div>

                <h3 className="text-xl font-semibold">
                  {feature.title}
                </h3>

                <p className="mt-2 text-gray-500">
                  {feature.description}
                </p>

              </div>

            </div>

          );

        })}

      </div>

    </section>
  );
}