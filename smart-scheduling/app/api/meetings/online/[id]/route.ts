import { NextRequest, NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, parseIdParam, rateLimit } from "@/lib/api";
import {
  OnlineMeetingError,
  retryOnlineMeetings,
} from "@/lib/services/online-meeting.service";

// "Retry Teams meeting": the Teams meeting of this booking could not be
// created (provisioning FAILED). The organizer (or an Admin) puts it back in
// the background queue; the worker creates it and the attendees are told when
// the link exists. A repeated request never creates a second Teams meeting.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const blocked =
      guardMutation(req, { expectJson: false }) ??
      rateLimit(organizer.employeeId, "online-meeting", 20);

    if (blocked) return blocked;

    const { id } = await params;
    const meetingId = parseIdParam(id);

    if (meetingId === null) return jsonError(400, "Invalid meeting id.");

    const online = await retryOnlineMeetings(meetingId, {
      employeeId: organizer.employeeId,
      role: organizer.role,
    });

    return NextResponse.json(
      {
        success: true,
        online,
        message:
          "The Teams meeting is being created. Attendees will receive the link by e-mail.",
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof OnlineMeetingError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
