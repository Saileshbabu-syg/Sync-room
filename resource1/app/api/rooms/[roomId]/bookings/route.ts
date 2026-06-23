import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { meetings } from "@/db/schema/meeting_dummy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;

    const date =
      request.nextUrl.searchParams.get("date");

    if (!date) {
      return NextResponse.json(
        {
          message: "Date is required",
        },
        {
          status: 400,
        }
      );
    }

    const bookedSlots = await db
      .select({
        startTime: meetings.startTime,
        endTime: meetings.endTime,
      })
      .from(meetings)
      .where(
        and(
          eq(meetings.roomId, Number(roomId)),
          eq(meetings.meetingDate, date)
        )
      );

    return NextResponse.json(bookedSlots);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        message: "Failed to fetch bookings",
      },
      {
        status: 500,
      }
    );
  }
}