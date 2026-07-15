import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { organizers } from "@/db/schema/organizer";
import { meeting } from "@/db/schema/meeting";
import { room } from "@/db/schema/rooms";
import { meetingTypes } from "@/db/schema/meetingTypes";
import { meetingStatuses } from "@/db/schema/meetingStatuses";

import {
  desc,
  eq,
} from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import BookingCard from "@/components/BookingCard";

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

    participantCount: meeting.participantCount,

    roomName: room.room_name,

    meetingType: meetingTypes.meetingTypeName,

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

  .orderBy(desc(meeting.meeting_date), desc(meeting.start_time));

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

        <div className="grid gap-6">

          {meetings.length === 0 ? (

            <div className="rounded-xl border bg-white p-10 text-center shadow">

              <h2 className="text-xl font-semibold">
                No Meetings Found
              </h2>

              <p className="mt-2 text-gray-500">
                You haven't booked any meetings yet.
              </p>

            </div>

          ) : (

            meetings.map((meeting: any) => (

              <BookingCard
                key={meeting.meetingId}
                meeting={meeting}
              />

            ))

          )}

        </div>

      </div>
    </BookingLayout>
  );
}