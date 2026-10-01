import { db } from "@/db";
import { meeting } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export async function checkMeetingConflict(
  roomId: number,
  meetingDate: string,
  startTime: string,
  endTime: string
) {
  const meetings = await db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        eq(meeting.meeting_date, meetingDate)
      )
    );

  const conflict = meetings.some((m) => {
    return (
      startTime < m.end_time &&
      endTime > m.start_time
    );
  });

  return conflict;
}