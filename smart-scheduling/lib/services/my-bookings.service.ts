import { db } from "@/db";
import {
  meeting,
  meeting_attendees,
  meetingStatuses,
  meetingTypes,
  room,
} from "@/db/schema";
import { and, desc, eq, exists, or, sql } from "drizzle-orm";

// A meeting belongs to an employee when they organize it or were added to it
// as a participant (a persisted meeting_attendees row; every occurrence of a
// recurring series has its own meeting row and its own attendee rows).
// `employeeId` must come from the authenticated session, never from a request.
export function involvesEmployee(employeeId: number) {
  return or(
    eq(meeting.organizerEmployeeId, employeeId),
    exists(
      db
        .select({ one: sql`1` })
        .from(meeting_attendees)
        .where(
          and(
            eq(meeting_attendees.meeting_id, meeting.meeting_id),
            eq(meeting_attendees.employee_id, employeeId)
          )
        )
    )
  );
}

export async function listMyBookings(employeeId: number) {
  return db
    .select({
      meetingId: meeting.meeting_id,
      title: meeting.title,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      participantCount: meeting.participantCount,
      roomName: room.room_name,
      meetingType: meetingTypes.meetingTypeName,
      meetingStatus: meetingStatuses.meetingStatusName,
      meetingStatusId: meeting.meetingStatusId,
      organizerEmployeeId: meeting.organizerEmployeeId,
    })
    .from(meeting)
    .leftJoin(room, eq(room.room_id, meeting.room_id))
    .leftJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, meeting.meetingTypeId)
    )
    .leftJoin(
      meetingStatuses,
      eq(meetingStatuses.meetingStatusId, meeting.meetingStatusId)
    )
    .where(involvesEmployee(employeeId))
    .orderBy(desc(meeting.meeting_date), desc(meeting.start_time));
}
