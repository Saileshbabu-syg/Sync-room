"use client";

import {
  Building2,
  CalendarCheck,
  CircleCheckBig,
} from "lucide-react";

const cards = [
  {
    title: "Total Rooms",
    value: "12",
    icon: Building2,
  },
  {
    title: "My Bookings",
    value: "8",
    icon: CalendarCheck,
  },
  {
    title: "Available Today",
    value: "5",
    icon: CircleCheckBig,
  },
];

export default function StatisticsCards() {
  return (
    <section className="mx-auto mt-10 max-w-7xl px-6">

      <div className="grid gap-6 md:grid-cols-3">

        {cards.map((card) => {

          const Icon = card.icon;

          return (

            <div
              key={card.title}
              className="rounded-3xl bg-white p-8 shadow-md transition-all duration-300 hover:-translate-y-1 hover:shadow-xl"
            >

              <div className="flex items-center justify-between">

                <div>

                  <p className="text-gray-500">

                    {card.title}

                  </p>

                  <h2 className="mt-3 text-4xl font-bold">

                    {card.value}

                  </h2>

                </div>

                <div className="rounded-2xl bg-blue-100 p-4">

                  <Icon className="h-8 w-8 text-blue-700" />

                </div>

              </div>

            </div>

          );
        })}
      </div>

    </section>
  );
}