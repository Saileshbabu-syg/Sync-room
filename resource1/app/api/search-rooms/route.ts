import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rooms } from "@/db/schema/rooms";
import { meetings } from "@/db/schema/meetings";
import { and, eq, gte } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const capacity = Number(params.get("capacity"));
  const date = params.get("date");
  const start = params.get("start");
  const end = params.get("end");
  const facility = params.get("facility");

  // Capacity filter
  const candidateRooms = await db
    .select()
    .from(rooms)
    .where(gte(rooms.roomCapacity, capacity));

  const availableRooms = [];

  for (const r of candidateRooms) {
    const roomMeetings = await db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.roomId, r.roomId),
          eq(meetings.meetingDate, date!)
        )
      );

    let isAvailable = true;

    for (const meeting of roomMeetings) {
      const overlap =
        start! < meeting.endTime &&
        end! > meeting.startTime;

      if (overlap) {
        isAvailable = false;
        break;
      }
    }

    if (isAvailable) {
      availableRooms.push(r);
    }
  }

  // Facility filter
  let result = availableRooms;

  if (facility) {
    result = availableRooms.filter((r) =>
      r.facilities?.includes(facility)
    );
  }

  return NextResponse.json(result);
}