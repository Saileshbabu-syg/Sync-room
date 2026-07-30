import {
  NextRequest,
  NextResponse,
} from "next/server";

import { recurringMeetingSchema } from "@/lib/validations/recurring-meeting";

import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";

export async function POST(
  req: NextRequest
) {
  try {
    const body = await req.json();

    const validatedData =
      recurringMeetingSchema.parse(
        body
      );

    const meetings =
      await createRecurringMeeting(
        validatedData
      );

    return NextResponse.json({
      success: true,
      data: meetings,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to create recurring meeting",
      },
      { status: 500 }
    );
  }
}