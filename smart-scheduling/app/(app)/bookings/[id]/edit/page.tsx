import { auth } from "@/auth";
import { parseIdParam } from "@/lib/api";
import { MEETING_STATUS, ROLE_ADMIN } from "@/lib/constants";
import { isMeetingEnded } from "@/lib/time";
import { getAllowedMeetingTypes } from "@/lib/services/meeting-type-access.service";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { meeting } from "@/db/schema";
import { meetingTypes } from "@/db/schema";
import { meeting_attendees } from "@/db/schema";
import { employee, reschedule_requests, roles, room } from "@/db/schema";

import { and, eq } from "drizzle-orm";
import { nowInAppTimezone } from "@/lib/time";

import EditMeetingForm from "@/components/EditMeetingForm";
import RescheduleMeetingForm from "@/components/RescheduleMeetingForm";

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

  const meetingId = parseIdParam(id);

  if (meetingId === null) {
    redirect("/bookings");
  }

  // Logged in Organizer

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

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
        meetingId
      )
    );

  if (meetingData.length === 0) {
    redirect("/bookings");
  }

  // Only the organizer or an Admin may open the edit form (the API enforces
  // the same rule). Others get the redirect used for unknown meetings.
  if (
    meetingData[0].organizerEmployeeId !== userProfile[0].employeeId &&
    userProfile[0].role !== ROLE_ADMIN
  ) {
    redirect("/bookings");
  }

  // Only Scheduled meetings can be edited, and meetings waiting to be
  // rescheduled after a bump can be moved.

  const isPending =
    meetingData[0].meetingStatusId === MEETING_STATUS.PENDING_RESCHEDULE;

  if (
    (meetingData[0].meetingStatusId !== MEETING_STATUS.SCHEDULED &&
      !isPending) ||
    isMeetingEnded(meetingData[0].meeting_date, meetingData[0].end_time)
  ) {
    redirect("/bookings");
  }

  if (isPending) {
    const rooms = await db
      .select({
        roomId: room.room_id,
        roomName: room.room_name,
        capacity: room.room_capacity,
        availabilityStatusId: room.availabilityStatusId,
      })
      .from(room);

    const [request] = await db
      .select({ deadline: reschedule_requests.deadline })
      .from(reschedule_requests)
      .where(
        and(
          eq(reschedule_requests.bumped_meeting_id, meetingId),
          eq(reschedule_requests.status, "PENDING")
        )
      );

    const due = request ? nowInAppTimezone(request.deadline) : null;

    return (
      <RescheduleMeetingForm
        meetingId={meetingData[0].meeting_id}
        title={meetingData[0].title}
        roomId={meetingData[0].room_id}
        meetingDate={meetingData[0].meeting_date}
        startTime={meetingData[0].start_time}
        endTime={meetingData[0].end_time}
        participantCount={meetingData[0].participantCount}
        deadline={due ? `${due.date} ${due.time.slice(0, 5)}` : null}
        rooms={rooms
          .filter((r) => r.availabilityStatusId === 1)
          .map(({ roomId, roomName, capacity }) => ({
            roomId,
            roomName,
            capacity,
          }))}
      />
    );
  }

  // Meeting Types

  // Only the types the meeting's organizer is allowed to use (the same rule
  // the edit API enforces).
  const [owner] = await db
    .select({ role: roles.roleName })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(eq(employee.employee_id, meetingData[0].organizerEmployeeId));

  const allowedTypes = owner
    ? await getAllowedMeetingTypes({
        employeeId: meetingData[0].organizerEmployeeId,
        roleName: owner.role,
      })
    : [];

  const meetingTypeList = (
    await db
      .select()
      .from(meetingTypes)
  ).filter(
    (t) =>
      t.meetingTypeId === meetingData[0].meetingTypeId ||
      allowedTypes.some((a) => a.meetingTypeId === t.meetingTypeId)
  );

  // Attendees

  const attendees = await db
    .select({
      employeeId:
        meeting_attendees.employee_id,
      isOptional: meeting_attendees.is_optional,
    })
    .from(meeting_attendees)
    .where(
      eq(
        meeting_attendees.meeting_id,
        meetingId
      )
    );

  // Remove organizer

  const invited = attendees.filter(
    (a) =>
      a.employeeId !==
      meetingData[0].organizerEmployeeId
  );

  const attendeeIds = invited
    .filter((a) => !a.isOptional)
    .map((a) => a.employeeId);

  const optionalAttendeeIds = invited
    .filter((a) => a.isOptional)
    .map((a) => a.employeeId);

  return (
    <>
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
        optionalAttendeeIds={optionalAttendeeIds}
        meetingTypes={meetingTypeList}
      />
    </>
  );
}