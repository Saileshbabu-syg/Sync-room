import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { organizers } from "@/db/schema";
import { meeting } from "@/db/schema";
import { meetingTypes } from "@/db/schema";
import { meeting_attendees } from "@/db/schema";

import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import EditMeetingForm from "@/components/EditMeetingForm";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function EditMeetingPage({
  params,
}: Props) {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  // Logged in Organizer

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

  if (userProfile.length === 0) {
    redirect("/login");
  }

  // Meeting Details

  const meetingData = await db
    .select()
    .from(meeting)
    .where(
      eq(
        meeting.meeting_id,
        Number(id)
      )
    );

  if (meetingData.length === 0) {
    redirect("/bookings");
  }

  // Only Scheduled meetings can be edited

  if (
    meetingData[0].meetingStatusId !== 1
  ) {
    redirect("/bookings");
  }

  // Meeting Types

  const meetingTypeList =
    await db
      .select()
      .from(meetingTypes);

  // Attendees

  const attendees = await db
    .select({
      employeeId:
        meeting_attendees.employee_id,
    })
    .from(meeting_attendees)
    .where(
      eq(
        meeting_attendees.meeting_id,
        Number(id)
      )
    );

  // Remove organizer

  const attendeeIds = attendees
    .map((a) => a.employeeId)
    .filter(
      (id) =>
        id !==
        meetingData[0]
          .organizerEmployeeId
    );

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <EditMeetingForm
        meetingId={
          meetingData[0].meeting_id
        }
        title={meetingData[0].title}
        participantCount={
          meetingData[0]
            .participantCount
        }
        meetingTypeId={
          meetingData[0]
            .meetingTypeId
        }
        attendeeIds={attendeeIds}
        meetingTypes={meetingTypeList}
      />
    </BookingLayout>
  );
}