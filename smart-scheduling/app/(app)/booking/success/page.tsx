import Link from "next/link";

import {
  CheckCircle2,
  Mail,
  CalendarPlus,
} from "lucide-react";

import { Home } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function BookingSuccessPage() {
  return (
    <div className="flex justify-center py-6 sm:py-10">

      <div className="w-full max-w-2xl text-center">

        <CheckCircle2 className="mx-auto h-20 w-20 text-green-600 sm:h-24 sm:w-24" aria-hidden />

        <h1 className="mt-6 text-3xl font-bold text-green-700 sm:mt-8 sm:text-4xl">
          Meeting Scheduled Successfully
        </h1>

        <p className="mt-4 text-lg text-gray-600">
          Your meeting has been scheduled successfully.
        </p>

        <div className="mt-8 rounded-xl border bg-slate-50 p-4 sm:mt-10 sm:p-6">

          <Mail className="mx-auto h-10 w-10 text-blue-600" aria-hidden />

          <h2 className="mt-4 text-xl font-semibold">
            Confirmation Email Sent
          </h2>

          <p className="mt-2 text-gray-600">
            A confirmation email has been sent to all meeting participants.
          </p>

        </div>

        <div className="mt-8 flex flex-col gap-4 sm:mt-10 md:flex-row md:justify-center">

          <Button size="lg" className="w-full md:w-auto" asChild>
            <Link href="/bookings">View My Bookings</Link>
          </Button>

          <Button variant="outline" size="lg" className="w-full md:w-auto" asChild>
            <Link href="/booking">
              <CalendarPlus className="mr-2 h-5 w-5" aria-hidden />
              Book Another Meeting
            </Link>
          </Button>

          <Button variant="outline" size="lg" className="w-full md:w-auto" asChild>
            <Link href="/home">
              <Home className="mr-2 h-5 w-5" aria-hidden />
              Home
            </Link>
          </Button>

        </div>

      </div>

    </div>
  );
}
