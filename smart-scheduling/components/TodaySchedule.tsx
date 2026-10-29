import Link from "next/link";

import {
  CalendarClock,
  Clock,
  Building2,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type Meeting = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  roomName: string | null;
};

type Props = {
  meetings: Meeting[];
};

export default function TodaySchedule({
  meetings,
}: Props) {

  return (
   
     <div className="h-[360px] rounded-3xl border bg-white p-8 shadow">

        <h2 className="mb-6 flex items-center gap-3 text-2xl font-bold">

          <CalendarClock className="h-7 w-7 text-blue-600" />

          Today&apos;s Schedule

        </h2>

        {meetings.length === 0 ? (

          <div className="py-10 text-center">

            <h3 className="text-lg font-semibold">
              No meetings scheduled today
            </h3>

            <p className="mt-2 text-gray-500">
              Enjoy your free day!
            </p>

          </div>

        ) : (

          <div className="mt-6 h-[240px] space-y-4 overflow-y-auto pr-2">

            {meetings.map((meeting) => (

              <div
                key={meeting.meetingId}
                className="flex items-center justify-between rounded-xl border p-5 transition hover:bg-slate-50"
              >

                <div>

                  <h3 className="text-lg font-semibold">
                    {meeting.title}
                  </h3>

                  <div className="mt-3 flex flex-wrap gap-6 text-sm text-gray-600">

                    <div className="flex items-center gap-2">

                      <Clock className="h-4 w-4 text-blue-600" />

                      {meeting.startTime} - {meeting.endTime}

                    </div>

                    <div className="flex items-center gap-2">

                      <Building2 className="h-4 w-4 text-blue-600" />

                      {meeting.roomName ?? "-"}

                    </div>

                  </div>

                </div>

                <Link
                  href={`/bookings/${meeting.meetingId}`}
                >

                  <Button
                    variant="outline"
                  >
                    View
                  </Button>

                </Link>

              </div>

            ))}

          </div>

        )}

      </div>

  );
}