"use client";

import Link from "next/link";

import CancelMeetingButton from "@/components/CancelMeetingButton";

import {
  CalendarDays,
  Clock,
  Users,
  Building2,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type Meeting = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
  roomName: string | null;
  meetingType: string | null;
  meetingStatus: string | null;
};

type Props = {
  meeting: Meeting;
};

export default function BookingCard({
  meeting,
}: Props) {
  return (
    <div className="rounded-2xl border bg-white p-6 shadow">

      <div className="flex items-start justify-between">

        <div>

          <h2 className="text-2xl font-bold">
            {meeting.title}
          </h2>

          <p className="mt-1 text-sm text-gray-500">
            {meeting.meetingType ?? "-"}
          </p>

        </div>

        <span
          className={`rounded-full px-3 py-1 text-sm font-medium
            ${
              meeting.meetingStatus === "Scheduled"
                ? "bg-green-100 text-green-700"
                : meeting.meetingStatus === "Completed"
                ? "bg-blue-100 text-blue-700"
                : "bg-red-100 text-red-700"
            }`}
        >
          {meeting.meetingStatus ?? "-"}
        </span>

      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">

        <div className="flex items-center gap-3">

          <Building2 className="h-5 w-5 text-blue-600" />

          <span>{meeting.roomName ?? "-"}</span>

        </div>

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

          <Users className="h-5 w-5 text-blue-600" />

          <span>
            {meeting.participantCount} Participants
          </span>

        </div>

      </div>

      <div className="mt-8 flex gap-3">

  {/* View Button - Always Visible */}

  <Link
    href={`/bookings/${meeting.meetingId}`}
  >
    <Button>
      View
    </Button>
  </Link>

  {/* Edit & Cancel Only for Scheduled */}

  {meeting.meetingStatus === "Scheduled" && (
    <>
      <Link
        href={`/bookings/${meeting.meetingId}/edit`}
      >
        <Button variant="outline">
          Edit
        </Button>
      </Link>

      <CancelMeetingButton
        meetingId={meeting.meetingId}
      />
    </>
  )}

</div>

    </div>
  );
}