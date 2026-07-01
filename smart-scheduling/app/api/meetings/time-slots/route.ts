import {
  NextRequest,
  NextResponse,
} from "next/server";

import { getSuggestedTimeSlots } from "@/lib/services/time-slot-suggestion.service";

export async function POST(
  req: NextRequest
) {
  try {
    const body = await req.json();

    const {
      room_id,
      meeting_date,
    } = body;

    const suggestions =
      await getSuggestedTimeSlots(
        room_id,
        meeting_date
      );

    return NextResponse.json({
      success: true,
      data: suggestions,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to fetch time slot suggestions",
      },
      { status: 500 }
    );
  }
}