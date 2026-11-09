"use client";

import { useState } from "react";
import Link from "next/link";

import BumpedDetails, { type BumpDetails } from "@/components/BumpedDetails";
import CancelMeetingButton from "@/components/CancelMeetingButton";
import JoinMeetingButton, { TeamsBadge } from "@/components/JoinMeetingButton";
import { StatusBadge, TeamsStatusBadge } from "@/components/StatusBadge";
import { MEETING_STATUS } from "@/lib/constants";
import { formatDate, formatTimeRange } from "@/lib/format";

import {
  CalendarDays,
  Clock,
  Users,
  Building2,
  ChevronDown,
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
  meetingStatusId: number;
  canManage: boolean;
  // Set when the meeting is an occurrence of a recurring series.
  recurringMeetingId?: number | null;
  isOnline?: boolean;
  onlineJoinUrl?: string | null;
  // A Teams meeting was asked for; onlineStatus says whether its link is
  // still being created (PENDING) or could not be (FAILED).
  onlineRequested?: boolean;
  onlineStatus?: string | null;
  // Set for a bumped booking: who took the room.
  bumped?: BumpDetails | null;
};

type Props = {
  meeting: Meeting;
};

export default function BookingCard({
  meeting,
}: Props) {
  const [showBump, setShowBump] = useState(false);

  const status = meeting.meetingStatusId;
  const scheduled = status === MEETING_STATUS.SCHEDULED;
  const pendingReschedule = status === MEETING_STATUS.PENDING_RESCHEDULE;

  return (
    <div className="rounded-2xl border bg-white p-4 shadow sm:p-6">

      <div className="flex flex-wrap items-start justify-between gap-3">

        <div className="min-w-0">

          <h2 className="break-words text-xl font-bold sm:text-2xl">
            {meeting.title}
          </h2>

          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
            {meeting.meetingType ?? "-"}
            {meeting.isOnline && <TeamsBadge />}
            {(scheduled || pendingReschedule) && (
              <TeamsStatusBadge
                onlineRequested={meeting.onlineRequested && !meeting.isOnline}
                onlineStatus={meeting.onlineStatus}
              />
            )}
          </p>

        </div>

        <StatusBadge statusId={status} className="text-sm" />

      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">

        <div className="flex items-center gap-3">

          <Building2 className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

          <span>{meeting.roomName ?? "-"}</span>

        </div>

        <div className="flex items-center gap-3">

          <CalendarDays className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

          <span>{formatDate(meeting.meetingDate)}</span>

        </div>

        <div className="flex items-center gap-3">

          <Clock className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

          <span>{formatTimeRange(meeting.startTime, meeting.endTime)}</span>

        </div>

        <div className="flex items-center gap-3">

          <Users className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />

          <span>
            {meeting.participantCount} Participants
          </span>

        </div>

      </div>

      {status === MEETING_STATUS.PREEMPTED && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowBump((open) => !open)}
            aria-expanded={showBump}
            data-testid="bump-toggle"
            className="flex w-full items-center justify-between rounded-lg border border-orange-200 bg-orange-50 px-4 py-2 text-left text-sm font-medium text-orange-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>
              {meeting.bumped
                ? `Replaced by ${meeting.bumped.byName}`
                : "Replaced by a higher-priority booking"}
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${showBump ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>

          {showBump && (
            <div className="mt-2">
              {meeting.bumped ? (
                <BumpedDetails bump={meeting.bumped} />
              ) : (
                <p className="rounded-lg border bg-slate-50 p-3 text-sm text-gray-600">
                  The details of the booking that took this room are not
                  available.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-3">

        {/* Join Meeting - online (Teams) meetings that still take place */}

        {meeting.isOnline &&
          meeting.onlineJoinUrl &&
          (scheduled || pendingReschedule) && (
            <JoinMeetingButton joinUrl={meeting.onlineJoinUrl} />
          )}

        {/* View - always */}

        <Button asChild>
          <Link href={`/bookings/${meeting.meetingId}`}>View</Link>
        </Button>

        {/* Reschedule & Cancel for a meeting whose room was taken; Edit &
            Cancel for a scheduled one. */}

        {meeting.canManage && (scheduled || pendingReschedule) && (
          <>
            <Button variant="outline" asChild>
              <Link href={`/bookings/${meeting.meetingId}/edit`}>
                {pendingReschedule ? "Reschedule" : "Edit"}
              </Link>
            </Button>

            <CancelMeetingButton
              meetingId={meeting.meetingId}
              inSeries={meeting.recurringMeetingId != null}
            />
          </>
        )}

      </div>

    </div>
  );
}
