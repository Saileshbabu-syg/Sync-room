import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizers } from "@/db/schema/organizer";

import BookingLayout from "@/components/BookingLayout";
import BookingDetailsCard from "@/components/BookingDetailsCard";

import { meeting } from "@/db/schema/meeting";
import { room } from "@/db/schema/rooms";
import { meetingTypes } from "@/db/schema/meetingTypes";
import { meetingStatuses } from "@/db/schema/meetingStatuses";
import { meeting_attendees } from "@/db/schema/meeting_attendees";
import { employee } from "@/db/schema/employee";

import {
  and,
  eq,
  ne,
} from "drizzle-orm";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function BookingViewPage({
  params,
}: Props) {

  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

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

 // Meeting Details
const meetingData = await db
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

    organizerEmployeeId:
      meeting.organizerEmployeeId,
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
      meeting.meeting_id,
      Number(id)
    )
  );

if (meetingData.length === 0) {
  redirect("/bookings");
}

// Organizer Details
const organizerDetails = await db
  .select({
    employeeId: employee.employee_id,

    employeeName:
      employee.employee_name,
  })
  .from(employee)
  .where(
    eq(
      employee.employee_id,
      meetingData[0].organizerEmployeeId
    )
  );

// Attendees
const attendees = await db
  .select({
    employeeId: employee.employee_id,

    employeeName:
      employee.employee_name,
  })
  .from(meeting_attendees)

  .leftJoin(
    employee,
    eq(
      employee.employee_id,
      meeting_attendees.employee_id
    )
  )

  .where(
    and(
      eq(
        meeting_attendees.meeting_id,
        Number(id)
      ),
      ne(
        meeting_attendees.employee_id,
        meetingData[0].organizerEmployeeId
      )
    )
  );

const meetingDetails = {
  ...meetingData[0],

  roomName: meetingData[0].roomName ?? "N/A",

  meetingType: meetingData[0].meetingType ?? "N/A",

  meetingStatus: meetingData[0].meetingStatus ?? "N/A",

  organizer: organizerDetails[0] ?? {
    employeeId: meetingData[0].organizerEmployeeId,
    employeeName: "Unknown Organizer",
  },

  attendees: attendees.map((attendee) => ({
    employeeId: attendee.employeeId ?? 0,
    employeeName: attendee.employeeName ?? "Unknown Employee",
  })),
};

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <BookingDetailsCard
        meeting={meetingDetails}
      />
    </BookingLayout>
  );
}