import { db } from "@/db";
import { room } from "@/db/schema/rooms";
import { meeting } from "@/db/schema/meeting";

import {
  and,
  eq,
  lt,
  gt,
} from "drizzle-orm";

export async function getAvailableRooms(
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number
) {
  // Find all meetings that conflict with the requested slot
  const conflictingMeetings = await db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.meeting_date, meetingDate),
        lt(meeting.start_time, endTime),
        gt(meeting.end_time, startTime)
      )
    );

  // Extract conflicting room ids
  const conflictingRoomIds = conflictingMeetings.map(
    (m) => m.room_id
  );

  // Get all rooms
  const allRooms = await db
    .select()
    .from(room);

  // Return only available rooms
   const requiredCapacity = participantCount;

return allRooms.filter(
  (r) =>
    !conflictingRoomIds.includes(r.room_id) &&
    r.room_capacity >= requiredCapacity
);
}

export async function isRoomAvailable(
  roomId: number,
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number
) {
  // Check room exists
  const roomDetails = await db.query.room.findFirst({
    where: eq(room.room_id, roomId),
  });

  if (!roomDetails) {
    return {
      success: false,
      message: "Room not found.",
    };
  }

  // Check room is available (Not under maintenance)
  if (roomDetails.availabilityStatusId !== 1) {
    return {
      success: false,
      message:
        "This room is currently unavailable for booking.",
    };
  }

  // Check room capacity
  if (participantCount > roomDetails.room_capacity) {
    return {
      success: false,
      message: `Room capacity is only ${roomDetails.room_capacity}.`,
    };
  }

  // Check room booking conflict
  const conflictingMeeting =
    await db.query.meeting.findFirst({
      where: and(
        eq(meeting.room_id, roomId),
        eq(meeting.meeting_date, meetingDate),
        lt(meeting.start_time, endTime),
        gt(meeting.end_time, startTime)
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

  return await db
    .select({
      title: meeting.title,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
    })
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        eq(
          meeting.meeting_date,
          meetingDate
        )
      )
    );

}