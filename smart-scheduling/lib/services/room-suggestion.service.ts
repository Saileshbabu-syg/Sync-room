import { and, eq, exists, ne, sql } from "drizzle-orm";

import { db } from "@/db";

import { room } from "@/db/schema";
import { meeting } from "@/db/schema";
import { meetingStatuses } from "@/db/schema";
import { meeting_attendees } from "@/db/schema";

import {
  AVAILABILITY_STATUS,
  MEETING_STATUS,
  ROLE_ADMIN,
} from "@/lib/constants";
import { nowInAppTimezone } from "@/lib/time";

import { holdsSlot, overlapsSlot } from "./conflict-check.service";

export async function getAvailableRooms(
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number
) {

  // Find meetings that conflict with the requested slot (half-open intervals,
  // evaluated in SQL on real time values — same rule as the booking path).

  const conflictingMeetings = await db
    .select({ roomId: meeting.room_id })
    .from(meeting)
    .where(
      and(
        eq(meeting.meeting_date, meetingDate),
        overlapsSlot(startTime, endTime),
        holdsSlot
      )
    );

  // Extract booked room ids

  const conflictingRoomIds = new Set(
    conflictingMeetings.map((m) => m.roomId)
  );

  // Fetch all rooms

  const allRooms = await db
    .select()
    .from(room);

  // Return only bookable rooms

  return allRooms.filter(
    (roomDetails) =>

      // Room should not already be booked
      !conflictingRoomIds.has(roomDetails.room_id)

      // Room should have enough capacity
      && roomDetails.room_capacity >= participantCount

      // Room should be Available
      && roomDetails.availabilityStatusId === AVAILABILITY_STATUS.AVAILABLE
  );

}

export async function isRoomAvailable(
  roomId: number,
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number
) {

  const roomDetails =
    await db.query.room.findFirst({
      where: eq(
        room.room_id,
        roomId
      ),
    });

  if (!roomDetails) {

    return {
      success: false,
      message: "Room not found.",
    };

  }

  // Room must be Available

  if (
    roomDetails.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE
  ) {

    return {
      success: false,
      message:
        "This room is currently unavailable for booking.",
    };

  }

  // Capacity validation

  if (
    participantCount >
    roomDetails.room_capacity
  ) {

    return {
      success: false,
      message: `Room capacity is only ${roomDetails.room_capacity}.`,
    };

  }

  // Time conflict validation

  const conflictingMeeting =
    await db.query.meeting.findFirst({
      where: and(
        eq(
          meeting.room_id,
          roomId
        ),
        eq(
          meeting.meeting_date,
          meetingDate
        ),
        overlapsSlot(startTime, endTime),
        holdsSlot
      ),
    });

  if (conflictingMeeting) {

    return {
      success: false,
      message:
        "Room is already booked for the selected time slot.",
    };

  }

  return {
    success: true,
    message: "Room is available.",
  };

}

export type ScheduleViewer = {
  employeeId: number;
  role: string;
};

// Room calendar for one day. Titles are private: only the organizer, the
// attendees and Admins see them; everyone else sees the slot as "Busy" (they
// still need the time range to know when the room is free).
export async function getRoomSchedule(
  roomId: number,
  meetingDate: string,
  viewer: ScheduleViewer
) {

  const current = nowInAppTimezone();

  const schedules = await db
    .select({
      title: meeting.title,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      status: meetingStatuses.meetingStatusName,
      organizerEmployeeId: meeting.organizerEmployeeId,
      isAttendee: exists(
        db
          .select({ one: sql`1` })
          .from(meeting_attendees)
          .where(
            and(
              eq(meeting_attendees.meeting_id, meeting.meeting_id),
              eq(meeting_attendees.employee_id, viewer.employeeId)
            )
          )
      ),
    })
    .from(meeting)
    .innerJoin(
      meetingStatuses,
      eq(
        meeting.meetingStatusId,
        meetingStatuses.meetingStatusId
      )
    )
    .where(
      and(
        eq(meeting.room_id, roomId),
        eq(meeting.meeting_date, meetingDate),

        // Hide cancelled meetings
        ne(
          meeting.meetingStatusId,
          MEETING_STATUS.CANCELLED
        )
      )
    );

  const visible =
    // If selected date is today, remove meetings that have already ended.
    meetingDate === current.date
      ? schedules.filter((m) => m.endTime > current.time)
      : schedules;

  return visible.map((m) => ({
    title:
      viewer.role === ROLE_ADMIN ||
      m.organizerEmployeeId === viewer.employeeId ||
      m.isAttendee
        ? m.title
        : "Busy",
    startTime: m.startTime,
    endTime: m.endTime,
    status: m.status,
  }));
}
