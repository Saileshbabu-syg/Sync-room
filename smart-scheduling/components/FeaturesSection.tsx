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
  },
  {
    icon: Building2,
    title: "Room Availability",
    description:
      "Check available rooms instantly.",
  },
  {
    icon: ClipboardCheck,
    title: "Manage Meetings",
    description:
      "View, edit and cancel bookings.",
  },
  {
    icon: MailCheck,
    title: "Email Notifications",
    description:
      "Automatic confirmation emails.",
  },
];

export default function FeaturesSection() {
  return (
    <section className="mx-auto mt-10 mb-14 max-w-7xl px-6">

      <h2 className="mb-8 text-3xl font-bold">

        Why Choose MeetSched?

      </h2>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">

        {features.map((feature) => {

          const Icon = feature.icon;

          return (

            <div
              key={feature.title}
              className="rounded-3xl bg-white p-8 shadow-md transition hover:shadow-xl"
            >

              <Icon className="mb-6 h-12 w-12 text-blue-700" />

              <h3 className="text-xl font-semibold">

                {feature.title}

              </h3>

              <p className="mt-4 text-gray-500">

                {feature.description}

              </p>

            </div>

          );
        })}
      </div>

    </section>
  );
}