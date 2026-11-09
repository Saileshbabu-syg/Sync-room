import Link from "next/link";

import {
  CalendarDays,
  Clock,
  Users,
  Building2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import JoinMeetingButton, { TeamsBadge } from "@/components/JoinMeetingButton";
import { TeamsStatusBadge } from "@/components/StatusBadge";
import { formatDate, formatTimeRange } from "@/lib/format";

type Props = {
  meeting: {
    meetingId: number;
    title: string;
    meetingDate: string;
    startTime: string;
    endTime: string;
    participantCount: number;
    roomName: string | null;
    isOnline?: boolean;
    onlineJoinUrl?: string | null;
    onlineRequested?: boolean;
    onlineStatus?: string | null;
  } | null;
};

export default function UpcomingMeetingCard({
  meeting,
}: Props) {

  return (
    <div className="rounded-3xl border bg-white p-4 shadow sm:p-8 lg:h-[360px]">

      <h2 className="mb-6 text-2xl font-bold">
        Upcoming Meeting
      </h2>

      {!meeting ? (

        <div className="py-10 text-center">

          <h3 className="text-lg font-semibold">
            No upcoming meetings
          </h3>

          <p className="mt-2 text-gray-500">
            You don&apos;t have any scheduled meetings.
          </p>

        </div>

      ) : (

        <>

          <h3 className="mb-6 flex flex-wrap items-center gap-3 break-words text-xl font-semibold sm:text-2xl">
            {meeting.title}
            {meeting.isOnline && <TeamsBadge />}
            <TeamsStatusBadge
              onlineRequested={meeting.onlineRequested && !meeting.isOnline}
              onlineStatus={meeting.onlineStatus}
            />
          </h3>

          <div className="grid gap-5 md:grid-cols-2">

            <div className="flex items-center gap-3">

              <CalendarDays className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

              <span>{formatDate(meeting.meetingDate)}</span>

            </div>

            <div className="flex items-center gap-3">

              <Clock className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

              <span>{formatTimeRange(meeting.startTime, meeting.endTime)}</span>

            </div>

            <div className="flex items-center gap-3">

              <Building2 className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

              <span>
                {meeting.roomName ?? "-"}
              </span>

            </div>

            <div className="flex items-center gap-3">

              <Users className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

              <span>
                {meeting.participantCount} Participants
              </span>

            </div>

          </div>

          <div className="mt-8 flex flex-wrap gap-3">

            {meeting.isOnline && meeting.onlineJoinUrl && (
              <JoinMeetingButton joinUrl={meeting.onlineJoinUrl} />
            )}

            <Button asChild>
              <Link href={`/bookings/${meeting.meetingId}`}>View Meeting</Link>
            </Button>

          </div>

        </>

      )}

    </div>

  );
}
