import { NextRequest, NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
} from "@/lib/api";
import { PERMISSION } from "@/lib/constants";
import { getPriorityContext } from "@/lib/services/group-context.service";
import { cancelMeetings, lifecycleError } from "@/lib/services/series.service";
import { scopeField } from "@/lib/validations/editMeeting.validator";

// Cancels a meeting. For an occurrence of a recurring series, `?scope=` picks
// "single" (default: this occurrence), "following" (this and later ones) or
// "series" (every upcoming occurrence). Only the organizer or an Admin may
// (checked in the service, under the row locks), and only with the group's
// booking.cancel permission.
export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      id: string;
    }>;
  }
) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const blocked =
      guardMutation(req, { expectJson: false }) ??
      rateLimit(organizer.employeeId, "cancel", 30);

    if (blocked) return blocked;

    // The group's permissions, read from the database (not the session).
    const standing = await getPriorityContext(organizer.employeeId);

    if (!standing.permissions.has(PERMISSION.BOOKING_CANCEL)) {
      return jsonError(403, "Your group is not allowed to cancel bookings.");
    }

    const { id } = await params;

    const meetingId = parseIdParam(id);

    if (meetingId === null) {
      return jsonError(400, "Invalid meeting id.");
    }

    const scope = scopeField.safeParse(
      req.nextUrl.searchParams.get("scope") ?? undefined
    );

    if (!scope.success) {
      return jsonError(400, "scope must be single, following or series.");
    }

    const { cancelledCount } = await cancelMeetings({
      meetingId,
      scope: scope.data,
      actor: { employeeId: organizer.employeeId, role: organizer.role },
    });

    return NextResponse.json(
      {
        success: true,
        message:
          cancelledCount > 1
            ? `${cancelledCount} meetings cancelled successfully.`
            : "Meeting cancelled successfully.",
        cancelledCount,
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    const known = lifecycleError(error);

    if (known) return jsonError(known.status, known.message, known.details);

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
