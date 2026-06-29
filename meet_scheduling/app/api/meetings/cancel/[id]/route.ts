import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { meetings } from "@/db/schema/meetings";
import { meetingStatuses } from "@/db/schema/meetingStatuses";
import { eq } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // 1. Check meeting exists
    const existingMeeting = await db.query.meetings.findFirst({
      where: eq(meetings.meetingId, Number(id)),
    });

    if (!existingMeeting) {
      return NextResponse.json(
        { message: "Meeting not found" },
        { status: 404 }
      );
    }

    // 2. Check if already cancelled
    if (existingMeeting.meetingStatusId === 2) {
      return NextResponse.json(
        { message: "Meeting is already cancelled" },
        { status: 400 }
      );
    }

    // 3. Get CANCELLED status id (dynamic, not hardcoded best practice)
    const cancelledStatus = await db.query.meetingStatuses.findFirst({
      where: eq(meetingStatuses.meetingStatusName, "Cancelled"),
    });

    if (!cancelledStatus) {
      return NextResponse.json(
        { message: "Cancelled status not configured" },
        { status: 500 }
      );
    }

    // 4. Update meeting status
    await db
      .update(meetings)
      .set({
        meetingStatusId: cancelledStatus.meetingStatusId,
      })
      .where(eq(meetings.meetingId, Number(id)));

    return NextResponse.json(
      {
        message: "Meeting cancelled successfully",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { message: "Something went wrong" },
      { status: 500 }
    );
  }
}