import { db } from "@/db";

import { room } from "@/db/schema/rooms";
import { meeting } from "@/db/schema/meeting";
import { meetingStatuses } from "@/db/schema/meetingStatuses";

import {
  and,
  eq,
  lt,
  gt,
  ne,
} from "drizzle-orm";

export async function getAvailableRooms(
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number
) {

  // Find meetings that conflict with the requested slot

  const conflictingMeetings = await db
    .select()
    .from(meeting)
    .where(
      and(
        eq(
          meeting.meeting_date,
          meetingDate
        ),
        lt(
          meeting.start_time,
          endTime
        ),
        gt(
          meeting.end_time,
          startTime
        )
      )
    );

  // Extract booked room ids

  const conflictingRoomIds =
    conflictingMeetings.map(
      (meeting) => meeting.room_id
    );

  // Fetch all rooms

  const allRooms = await db
    .select()
    .from(room);

  // Return only bookable rooms

  return allRooms.filter(
    (roomDetails) =>

      // Room should not already be booked
      !conflictingRoomIds.includes(
        roomDetails.room_id
      )

      // Room should have enough capacity
      && roomDetails.room_capacity >= participantCount

      // Room should be Available
      && roomDetails.availabilityStatusId === 1
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
    roomDetails.availabilityStatusId !== 1
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
        lt(
          meeting.start_time,
          endTime
        ),
        gt(
          meeting.end_time,
          startTime
        )
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

export async function getRoomSchedule(
  roomId: number,
  meetingDate: string
) {

  const today =
    new Date().toISOString().split("T")[0];

  const currentTime =
    new Date().toTimeString().slice(0, 8);

  const schedules = await db
    .select({
      title: meeting.title,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      status: meetingStatuses.meetingStatusName,
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
          meetingStatuses.meetingStatusName,
          "Cancelled"
        )
      )
    );

  // If selected date is today,
  // remove meetings that have already ended.

  if (meetingDate === today) {

    return schedules.filter(
      (meeting) =>
        meeting.endTime > currentTime
    );

  }

  return schedules;
}