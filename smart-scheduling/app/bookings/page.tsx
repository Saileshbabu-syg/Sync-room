import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { organizers } from "@/db/schema";
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

  const userProfile = await db
    .select({
      organizerId: organizers.organizerId,
      employeeId: organizers.employeeId,
      name: organizers.name,
      email: organizers.email,
      role: organizers.role,
      imageUrl: organizers.imageUrl,
    })
    .from(organizers)
    .where(
      eq(
        organizers.email,
        session.user!.email!
      )
    );

  const meetings = await db
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