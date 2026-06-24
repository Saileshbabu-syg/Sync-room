import { NextRequest, NextResponse } from "next/server";

import { checkMeetingConflict } from "@/lib/services/conflict-check.service";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      room_id,
      meeting_date,
      start_time,
      end_time,
    } = body;

    const conflict = await checkMeetingConflict(
      room_id,
      meeting_date,
      start_time,
      end_time
    );

    return NextResponse.json({
      success: true,
      conflict,
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