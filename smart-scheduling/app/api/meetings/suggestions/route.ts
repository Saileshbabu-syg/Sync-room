import { NextRequest, NextResponse } from "next/server";

import { getAvailableRooms } from "@/lib/services/room-suggestion.service";

export async function POST(
  req: NextRequest
) {
  try {
    const body = await req.json();

    const {
      meeting_date,
      start_time,
      end_time,
    } = body;

    const availableRooms =
      await getAvailableRooms(
        meeting_date,
        start_time,
        end_time
      );

    return NextResponse.json({
      success: true,
      data: availableRooms,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch room suggestions",
      },
      { status: 500 }
    );
  }
}