import {
  NextRequest,
  NextResponse,
} from "next/server";

import { db } from "@/db";
import { jsonError, parseIdParam, readJson } from "@/lib/api";
import { isValidInternalSecret } from "@/lib/internal-secret";
import {
  deliverNotification,
  queueMeetingNotification,
} from "@/lib/services/notification.service";

// Internal, server-to-server only: re-sends the update e-mail for a meeting.
// Disabled (always 401) unless INTERNAL_API_SECRET is configured; the app's own
// routes no longer use it.
export async function POST(
  req: NextRequest
) {
  try {

    if (
      !isValidInternalSecret(req.headers.get("x-internal-secret"))
    ) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const meetingId = parseIdParam(
      String((body.data as { meetingId?: unknown } | null)?.meetingId ?? "")
    );

    if (meetingId === null) {
      return jsonError(400, "meetingId must be a positive integer.");
    }

    const notificationId = await queueMeetingNotification(
      db,
      meetingId,
      "UPDATED"
    );

    await deliverNotification(notificationId);

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
