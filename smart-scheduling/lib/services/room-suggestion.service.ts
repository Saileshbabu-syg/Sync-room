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
    return allRooms.filter(
      (r) =>
        !conflictingRoomIds.includes(r.room_id) &&
        r.room_capacity >= participantCount
    );
}