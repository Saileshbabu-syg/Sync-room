import { NextRequest, NextResponse } from "next/server";
import {
  getMeetingsByRoomAndDate,
  hasTimeConflict,
} from "@/lib/services/conflict-check.service";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      room_id,
      meeting_date,
      start_time,
      end_time,
    } = body;

    const meetings = await getMeetingsByRoomAndDate(
      room_id,
      meeting_date
    );

    const conflictingMeeting = meetings.find((meeting) =>
      hasTimeConflict(
        meeting.start_time,
        meeting.end_time,
        start_time,
        end_time
      )
    );

    if (conflictingMeeting) {
      return NextResponse.json({
        success: false,
        conflict: true,
        message: "Meeting room already booked",
        existingMeeting: conflictingMeeting,
      });
    }

    return NextResponse.json({
      success: true,
      conflict: false,
      message: "Room available",
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}