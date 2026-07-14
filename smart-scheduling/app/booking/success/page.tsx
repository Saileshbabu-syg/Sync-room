import Link from "next/link";

import {
  CheckCircle2,
  Mail,
  CalendarPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";

export default function BookingSuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-6">

      <div className="w-full max-w-2xl rounded-2xl bg-white p-10 text-center shadow-xl">

        <CheckCircle2 className="mx-auto h-24 w-24 text-green-600" />

        <h1 className="mt-8 text-4xl font-bold text-green-700">
          Meeting Scheduled Successfully
        </h1>

        <p className="mt-4 text-lg text-gray-600">
          Your meeting has been scheduled successfully.
        </p>

        <div className="mt-10 rounded-xl border bg-slate-50 p-6">

          <Mail className="mx-auto h-10 w-10 text-blue-600" />

          <h2 className="mt-4 text-xl font-semibold">
            Confirmation Email Sent
          </h2>

          <p className="mt-2 text-gray-600">
            A confirmation email has been sent to all meeting participants.
          </p>

        </div>

        <div className="mt-10 flex flex-col gap-4 md:flex-row md:justify-center">

          <Link href="/bookings">

            <Button
              size="lg"
              className="w-full md:w-60"
            >
              View My Bookings
            </Button>

          </Link>

          <Link href="/booking">

            <Button
              variant="outline"
              size="lg"
              className="w-full md:w-60"
            >
              <CalendarPlus className="mr-2 h-5 w-5" />

              Book Another Meeting
            </Button>

          </Link>

        </div>

      </div>

    </div>
  );
}