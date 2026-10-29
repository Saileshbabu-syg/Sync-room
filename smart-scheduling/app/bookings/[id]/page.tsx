import { auth } from "@/auth";
import { parseIdParam } from "@/lib/api";
import { ROLE_ADMIN } from "@/lib/constants";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import { db } from "@/db";

import BookingLayout from "@/components/BookingLayout";
import BookingDetailsCard from "@/components/BookingDetailsCard";

import { meeting } from "@/db/schema";
import { room } from "@/db/schema";
import { meetingTypes } from "@/db/schema";
import { meetingStatuses } from "@/db/schema";
import { meeting_attendees } from "@/db/schema";
import { employee } from "@/db/schema";

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

  const meetingId = parseIdParam(id);

  if (meetingId === null) {
    redirect("/bookings");
  }

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

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
      meetingId
    )
  );

if (meetingData.length === 0) {
  redirect("/bookings");
}

// Access policy: a meeting's details are visible to its organizer, its
// attendees and Admins. Anyone else gets the same redirect as for a meeting
// that does not exist, so ids cannot be probed.
const isOrganizer =
  meetingData[0].organizerEmployeeId === userProfile[0].employeeId;

let canView = isOrganizer || userProfile[0].role === ROLE_ADMIN;

if (!canView) {
  const [attendance] = await db
    .select({ id: meeting_attendees.meeting_attendee_id })
    .from(meeting_attendees)
    .where(
      and(
        eq(meeting_attendees.meeting_id, meetingId),
        eq(meeting_attendees.employee_id, userProfile[0].employeeId)
      )
    );

  canView = Boolean(attendance);
}

if (!canView) {
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
        meetingId
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