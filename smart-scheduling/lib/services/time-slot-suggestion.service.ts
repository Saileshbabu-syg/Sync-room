import { db } from "@/db";
import { meeting } from "@/db/schema";
import { and, eq } from "drizzle-orm";

function addOneHour(time: string): string {
  const [hours, minutes] = time
    .split(":")
    .map(Number);

  const nextHour = (hours + 1) % 24;

  return `${nextHour
    .toString()
    .padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:00`;
}

export async function getSuggestedTimeSlots(
  roomId: number,
  meetingDate: string
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

  return meetings.map((m) => ({
    suggested_start_time: m.end_time,
    suggested_end_time: addOneHour(
      String(m.end_time)
    ),
  }));
}