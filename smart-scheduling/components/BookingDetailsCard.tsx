"use client";

import Link from "next/link";

import { invitationCategory, MEETING_STATUS } from "@/lib/constants";
import { formatDate, formatTimeRange } from "@/lib/format";
import BumpedDetails, { type BumpDetails } from "@/components/BumpedDetails";
import CancelMeetingButton from "@/components/CancelMeetingButton";
import JoinMeetingButton, { TeamsBadge } from "@/components/JoinMeetingButton";
import RetryTeamsButton from "@/components/RetryTeamsButton";
import { StatusBadge, TeamsStatusBadge } from "@/components/StatusBadge";

import {
  CalendarDays,
  Clock,
  Building2,
  ClipboardList,
  Users,
  UserCircle,
  BadgeCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type Attendee = {
  employeeId: number;
  employeeName: string;
  isOptional: boolean;
  // ACCEPTED | DECLINED | NO_RESPONSE
  response: string;
};

const RESPONSE_TEXT: Record<string, string> = {
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  NO_RESPONSE: "No Response",
};

type Meeting = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
  roomName: string;
  meetingType: string;
  meetingStatusId: number;

  organizer: {
    employeeId: number;
    employeeName: string;
  };

  attendees: Attendee[];

  // Organizer or Admin; participants only view.
  canManage: boolean;

  // Set when the meeting is an occurrence of a recurring series.
  recurringMeetingId?: number | null;

  // Online Teams Meeting. The link is only passed to people who may view the
  // meeting. onlineStatus: PENDING while the Teams meeting is being created
  // or updated in the background, FAILED when that gave up (retry possible).
  isOnline: boolean;
  onlineJoinUrl: string | null;
  onlineRequested: boolean;
  onlineStatus?: string;

  // Set for a bumped booking: who took the room.
  bumped?: BumpDetails | null;
};

type Props = {
  meeting: Meeting;
};

const section = "rounded-2xl border bg-white p-4 shadow sm:p-8";

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof ClipboardList;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Icon className="shrink-0 text-blue-600" aria-hidden />

      <div className="min-w-0">
        <p className="text-sm text-gray-500">{label}</p>
        <div className="break-words font-semibold">{children}</div>
      </div>
    </div>
  );
}

export default function BookingDetailsCard({
  meeting,
}: Props) {
  const status = meeting.meetingStatusId;
  const scheduled = status === MEETING_STATUS.SCHEDULED;
  const pendingReschedule = status === MEETING_STATUS.PENDING_RESCHEDULE;
  const teamsNotReady = meeting.onlineRequested && !meeting.isOnline;

  return (
    <div className="space-y-8">

      {/* Meeting Information */}

      <div className={section}>

        <h2 className="mb-6 text-2xl font-bold">
          Meeting Information
        </h2>

        <div className="grid gap-5 md:grid-cols-2">

          <Field icon={ClipboardList} label="Title">
            {meeting.title}
          </Field>

          <Field icon={Building2} label="Room">
            {meeting.roomName}
          </Field>

          <Field icon={CalendarDays} label="Meeting Date">
            {formatDate(meeting.meetingDate)}
          </Field>

          <Field icon={Clock} label="Time">
            {formatTimeRange(meeting.startTime, meeting.endTime)}
          </Field>

          <Field icon={BadgeCheck} label="Meeting Type">
            <span className="flex flex-wrap items-center gap-2">
              {meeting.meetingType}
              {meeting.isOnline && <TeamsBadge />}
            </span>
          </Field>

          <Field icon={Users} label="Participants">
            {meeting.participantCount}
          </Field>

          <Field icon={BadgeCheck} label="Status">
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge statusId={status} className="text-sm" />
              {(scheduled || pendingReschedule) && (
                <TeamsStatusBadge
                  onlineRequested={teamsNotReady}
                  onlineStatus={meeting.onlineStatus}
                  className="text-sm"
                />
              )}
            </span>
          </Field>

        </div>

      </div>

      {meeting.bumped && <BumpedDetails bump={meeting.bumped} />}

      {/* Online Teams Meeting */}

      {meeting.isOnline &&
        meeting.onlineJoinUrl &&
        (scheduled || pendingReschedule) && (
          <div className={section}>
            <h2 className="mb-2 text-2xl font-bold">
              Microsoft Teams Meeting
            </h2>

            <p className="mb-4 break-all text-sm text-gray-500">
              {meeting.onlineJoinUrl}
            </p>

            <JoinMeetingButton joinUrl={meeting.onlineJoinUrl} />
          </div>
        )}

      {teamsNotReady &&
        meeting.onlineStatus === "PENDING" &&
        scheduled && (
          <div
            className="rounded-2xl border border-blue-200 bg-blue-50 p-6 text-blue-900"
            data-testid="teams-pending"
            role="status"
          >
            The Microsoft Teams link is being prepared. Attendees receive it by
            e-mail as soon as it is ready.
          </div>
        )}

      {/* FAILED: the organizer gets the retry; everyone else is told why
          there is no link yet. */}
      {teamsNotReady &&
        meeting.onlineStatus === "FAILED" &&
        scheduled &&
        (meeting.canManage ? (
          <RetryTeamsButton meetingId={meeting.meetingId} />
        ) : (
          <div
            className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900"
            data-testid="teams-failed"
            role="status"
          >
            The Microsoft Teams link could not be created. The room booking is
            unaffected; the organizer can try again.
          </div>
        ))}

      {/* Organizer */}

      <div className={section}>

        <h2 className="mb-6 text-2xl font-bold">
          Organizer
        </h2>

        <div className="flex items-center gap-4">

          <UserCircle
            size={50}
            className="shrink-0 text-blue-600"
            aria-hidden
          />

          <div className="min-w-0">

            <p className="break-words text-lg font-semibold">
              {meeting.organizer.employeeName}
            </p>

            <p className="text-gray-500">
              Employee ID : {meeting.organizer.employeeId}
            </p>

          </div>

        </div>

      </div>

      {/* Attendees */}

      <div className={section}>

        <h2 className="mb-6 text-2xl font-bold">
          Attendees
        </h2>

        {meeting.attendees.length === 0 ? (

          <p className="text-gray-500">
            No attendees added.
          </p>

        ) : (

          <div className="space-y-4">

            {meeting.attendees.map((attendee) => (

              <div
                key={attendee.employeeId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              >

                <div className="min-w-0">

                  <p className="break-words font-semibold">
                    {attendee.employeeName}
                  </p>

                  <p className="text-sm text-gray-500">
                    Employee ID : {attendee.employeeId}
                  </p>

                </div>

                <div className="text-sm sm:text-right">

                  <p className="font-medium">
                    {invitationCategory(attendee.isOptional)}
                  </p>

                  <p className="text-gray-500">
                    {RESPONSE_TEXT[attendee.response] ?? "No Response"}
                  </p>

                </div>

              </div>

            ))}

          </div>

        )}

      </div>

      {/* Buttons: Reschedule (room taken) or Edit (scheduled), and Cancel */}

      {meeting.canManage && (scheduled || pendingReschedule) && (
        <div className="flex flex-wrap gap-4">
          <Button asChild>
            <Link href={`/bookings/${meeting.meetingId}/edit`}>
              {pendingReschedule ? "Reschedule" : "Edit"}
            </Link>
          </Button>

          <CancelMeetingButton
            meetingId={meeting.meetingId}
            inSeries={meeting.recurringMeetingId != null}
          />
        </div>
      )}

    </div>
  );
}
