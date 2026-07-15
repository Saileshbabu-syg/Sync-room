"use client";

import Link from "next/link";

import CancelMeetingButton from "@/components/CancelMeetingButton";

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
  meetingStatus: string;

  organizer: {
    employeeId: number;
    employeeName: string;
  };

  attendees: Attendee[];
};

type Props = {
  meeting: Meeting;
};

export default function BookingDetailsCard({
  meeting,
}: Props) {
  return (
    <div className="space-y-8">

      {/* Meeting Information */}

      <div className="rounded-2xl border bg-white p-8 shadow">

        <h2 className="mb-6 text-2xl font-bold">
          Meeting Information
        </h2>

        <div className="grid gap-5 md:grid-cols-2">

          <div className="flex items-center gap-3">

            <ClipboardList className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Title
              </p>

              <p className="font-semibold">
                {meeting.title}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <Building2 className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Room
              </p>

              <p className="font-semibold">
                {meeting.roomName}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <CalendarDays className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Meeting Date
              </p>

              <p className="font-semibold">
                {meeting.meetingDate}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <Clock className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Time
              </p>

              <p className="font-semibold">
                {meeting.startTime} - {meeting.endTime}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <BadgeCheck className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Meeting Type
              </p>

              <p className="font-semibold">
                {meeting.meetingType}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <Users className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Participants
              </p>

              <p className="font-semibold">
                {meeting.participantCount}
              </p>

            </div>

          </div>

          {/* Status */}

          <div className="flex items-center gap-3">

            <BadgeCheck
              className={
                meeting.meetingStatus === "Scheduled"
                  ? "text-green-600"
                  : meeting.meetingStatus === "Completed"
                  ? "text-blue-600"
                  : "text-red-600"
              }
            />

            <div>

              <p className="text-sm text-gray-500">
                Status
              </p>

              <span
                className={`rounded-full px-3 py-1 text-sm font-semibold
                  ${
                    meeting.meetingStatus === "Scheduled"
                      ? "bg-green-100 text-green-700"
                      : meeting.meetingStatus === "Completed"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-red-100 text-red-700"
                  }`}
              >
                {meeting.meetingStatus}
              </span>

            </div>

          </div>

        </div>

      </div>

      {/* Organizer */}

      <div className="rounded-2xl border bg-white p-8 shadow">

        <h2 className="mb-6 text-2xl font-bold">
          Organizer
        </h2>

        <div className="flex items-center gap-4">

          <UserCircle
            size={50}
            className="text-blue-600"
          />

          <div>

            <p className="font-semibold text-lg">
              {meeting.organizer.employeeName}
            </p>

            <p className="text-gray-500">
              Employee ID : {meeting.organizer.employeeId}
            </p>

          </div>

        </div>

      </div>

      {/* Attendees */}

      <div className="rounded-2xl border bg-white p-8 shadow">

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
                className="flex items-center justify-between rounded-lg border p-4"
              >

                <div>

                  <p className="font-semibold">
                    {attendee.employeeName}
                  </p>

                  <p className="text-sm text-gray-500">
                    Employee ID : {attendee.employeeId}
                  </p>

                </div>

              </div>

            ))}

          </div>

        )}

      </div>

      {/* Buttons */}

      <div className="flex gap-4">

        <Link href="/bookings">

          <Button variant="outline">
            Back
          </Button>

        </Link>

        {meeting.meetingStatus === "Scheduled" && (
          <>
            <Link
              href={`/bookings/${meeting.meetingId}/edit`}
            >
              <Button>
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