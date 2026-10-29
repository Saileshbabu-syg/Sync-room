import Link from "next/link";

import {
  CalendarDays,
  Clock,
  Users,
  Building2,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  meeting: {
    meetingId: number;
    title: string;
    meetingDate: string;
    startTime: string;
    endTime: string;
    participantCount: number;
    roomName: string | null;
  } | null;
};

export default function UpcomingMeetingCard({
  meeting,
}: Props) {

  return (
    <div className="h-[360px] rounded-3xl border bg-white p-8 shadow">

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

            <h3 className="mb-6 text-2xl font-semibold">
              {meeting.title}
            </h3>

            <div className="grid gap-5 md:grid-cols-2">

              <div className="flex items-center gap-3">

                <CalendarDays className="h-5 w-5 text-blue-600" />

                <span>{meeting.meetingDate}</span>

              </div>

              <div className="flex items-center gap-3">

                <Clock className="h-5 w-5 text-blue-600" />

                <span>
                  {meeting.startTime} - {meeting.endTime}
                </span>

              </div>

              <div className="flex items-center gap-3">

                <Building2 className="h-5 w-5 text-blue-600" />

                <span>
                  {meeting.roomName ?? "-"}
                </span>

              </div>

              <div className="flex items-center gap-3">

                <Users className="h-5 w-5 text-blue-600" />

                <span>
                  {meeting.participantCount} Participants
                </span>

              </div>

            </div>

            <div className="mt-8">

              <Link
                href={`/bookings/${meeting.meetingId}`}
              >

                <Button>

                  View Meeting

                </Button>

              </Link>

            </div>

          </>

        )}

      </div>

  );
}