import { db } from "@/db";
import { meeting } from "@/db/schema/meeting";
import { and, eq } from "drizzle-orm";

export async function getMeetingsByRoomAndDate(
  roomId: number,
  meetingDate: string
) {
  return await db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        eq(meeting.meeting_date, meetingDate)
      )
    );
}

export function hasTimeConflict(
  existingStart: string,
  existingEnd: string,
  newStart: string,
  newEnd: string
) {
  return (
    newStart < existingEnd &&
    newEnd > existingStart
  );
}