import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { MEETING_STATUS_LABEL } from "@/lib/constants";

import { meeting } from "@/db/schema";
import { room } from "@/db/schema";
import { meetingTypes } from "@/db/schema";
import { meetingStatuses } from "@/db/schema";

import {
  desc,
  eq,
} from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import BookingTabs from "@/components/BookingTabs";

export default async function MyBookingsPage() {

  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

  const rows = await db
    .select({
      meetingId: meeting.meeting_id,

      title: meeting.title,

      meetingDate: meeting.meeting_date,

      startTime: meeting.start_time,

      endTime: meeting.end_time,

      participantCount:
        meeting.participantCount,

      roomName: room.room_name,

      meetingType:
        meetingTypes.meetingTypeName,

      meetingStatus:
        meetingStatuses.meetingStatusName,

      meetingStatusId: meeting.meetingStatusId,
    })

    .from(meeting)

    .leftJoin(
      room,
      eq(room.room_id, meeting.room_id)
    )

    .leftJoin(
      meetingTypes,
      eq(
        meetingTypes.meetingTypeId,
        meeting.meetingTypeId
      )
    )

    .leftJoin(
      meetingStatuses,
      eq(
        meetingStatuses.meetingStatusId,
        meeting.meetingStatusId
      )
    )

    .where(
      eq(
        meeting.organizerEmployeeId,
        userProfile[0].employeeId
      )
    )

    .orderBy(
      desc(meeting.meeting_date),
      desc(meeting.start_time)
    );

  // The label comes from the status id, not from how the name is spelled or
  // cased in the database.
  const meetings = rows.map((row) => ({
    ...row,
    meetingStatus:
      MEETING_STATUS_LABEL[row.meetingStatusId] ?? row.meetingStatus,
  }));

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >

      <div className="space-y-8">

        <div>

          <h1 className="text-3xl font-bold">
            My Bookings
          </h1>

          <p className="mt-2 text-gray-500">
            View and manage all your meetings.
          </p>

        </div>

        <BookingTabs
          meetings={meetings}
        />

      </div>

    </BookingLayout>
  );
}