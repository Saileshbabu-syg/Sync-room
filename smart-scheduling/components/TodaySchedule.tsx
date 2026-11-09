import Link from "next/link";

import {
  CalendarClock,
  Clock,
  Building2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import JoinMeetingButton, { TeamsBadge } from "@/components/JoinMeetingButton";
import { TeamsStatusBadge } from "@/components/StatusBadge";
import { formatTimeRange } from "@/lib/format";

type Meeting = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  roomName: string | null;
  isOnline?: boolean;
  onlineJoinUrl?: string | null;
  onlineRequested?: boolean;
  onlineStatus?: string | null;
};

type Props = {
  meetings: Meeting[];
};

// Today's scheduled meetings. A fixed height on large screens (side by side
// with Upcoming Meeting); on small screens it grows with its content.
export default function TodaySchedule({
  meetings,
}: Props) {

  return (

    <div className="flex flex-col rounded-3xl border bg-white p-4 shadow sm:p-8 lg:h-[360px]">

      <h2 className="mb-6 flex items-center gap-3 text-2xl font-bold">

        <CalendarClock className="h-7 w-7 text-blue-600" aria-hidden />

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

        <ul className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">

          {meetings.map((meeting) => (

            <li
              key={meeting.meetingId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 transition hover:bg-slate-50 sm:p-5"
            >

              <div className="min-w-0">

                <h3 className="flex flex-wrap items-center gap-2 break-words text-lg font-semibold">
                  {meeting.title}
                  {meeting.isOnline && <TeamsBadge />}
                  <TeamsStatusBadge
                    onlineRequested={meeting.onlineRequested && !meeting.isOnline}
                    onlineStatus={meeting.onlineStatus}
                  />
                </h3>

                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-600">

                  <div className="flex items-center gap-2">

                    <Clock className="h-4 w-4 text-blue-600" aria-hidden />

                    {formatTimeRange(meeting.startTime, meeting.endTime)}

                  </div>

                  <div className="flex items-center gap-2">

                    <Building2 className="h-4 w-4 text-blue-600" aria-hidden />

                    {meeting.roomName ?? "-"}

                  </div>

                </div>

              </div>

              <div className="flex gap-2">

                {meeting.isOnline && meeting.onlineJoinUrl && (
                  <JoinMeetingButton joinUrl={meeting.onlineJoinUrl} />
                )}

                <Button variant="outline" asChild>
                  <Link href={`/bookings/${meeting.meetingId}`}>View</Link>
                </Button>

              </div>

            </li>

          ))}

        </ul>

      )}

    </div>

  );
}
