import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { meeting } from "@/db/schema/meeting";
import { and, eq, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const roomId = Number(searchParams.get("roomId"));
  const meetingDate = searchParams.get("date");
  const startTime = searchParams.get("start");
  const endTime = searchParams.get("end");

  const conflicts = await db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        eq(meeting.meeting_date, meetingDate!),
        sql`${startTime} < ${meeting.end_time}
            AND
            ${endTime} > ${meeting.start_time}`
      )
    );

  return NextResponse.json({
    available: conflicts.length === 0,
    conflicts,
  });
}