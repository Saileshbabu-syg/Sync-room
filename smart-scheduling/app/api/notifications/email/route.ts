import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  notifyMeetingBooked,
} from "@/lib/services/notification.service";

export async function POST(
  req: NextRequest
) {
  try {

    const { meetingId } =
      await req.json();

    await notifyMeetingBooked(
      meetingId
    );

    return NextResponse.json({
      success: true,
      message:
        "Meeting notification sent",
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to send notification",
      },
      {
        status: 500,
      }
    );
  }
}