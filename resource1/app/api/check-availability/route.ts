import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { meetings } from "@/db/schema/meeting_dummy";
import { and, eq, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const roomId = Number(searchParams.get("roomId"));
  const meetingDate = searchParams.get("date");
  const startTime = searchParams.get("start");
  const endTime = searchParams.get("end");

  const conflicts = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.roomId, roomId),
        eq(meetings.meetingDate, meetingDate!),
        sql`${startTime} < ${meetings.endTime}
            AND
            ${endTime} > ${meetings.startTime}`
      )
    );

  return NextResponse.json({
    available: conflicts.length === 0,
    conflicts,
  });
}