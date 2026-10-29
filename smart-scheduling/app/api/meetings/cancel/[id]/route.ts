import { NextRequest, NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { meeting } from "@/db/schema";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
} from "@/lib/api";
import { MEETING_STATUS, ROLE_ADMIN } from "@/lib/constants";
import { isMeetingEnded } from "@/lib/time";
import { AUDIT_ACTION, createAuditLog } from "@/lib/services/audit.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "@/lib/services/notification.service";

class CancelError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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

    const { id } = await params;

    const meetingId = parseIdParam(id);

    if (meetingId === null) {
      return jsonError(400, "Invalid meeting id.");
    }

    const notificationId = await db.transaction(async (tx) => {
      // Lock the row so a concurrent edit/cancel cannot interleave.
      const [existingMeeting] = await tx
        .select()
        .from(meeting)
        .where(eq(meeting.meeting_id, meetingId))
        .for("update");

      if (!existingMeeting) {
        throw new CancelError("Meeting not found.", 404);
      }

      // Only the organizer or an Admin (current role, not the session's) may
      // cancel a meeting.
      if (
        existingMeeting.organizerEmployeeId !== organizer.employeeId &&
        organizer.role !== ROLE_ADMIN
      ) {
        throw new CancelError(
          "You do not have permission to cancel this meeting.",
          403
        );
      }

      if (existingMeeting.meetingStatusId === MEETING_STATUS.COMPLETED) {
        throw new CancelError("Completed meetings cannot be cancelled.", 400);
      }

      if (existingMeeting.meetingStatusId === MEETING_STATUS.CANCELLED) {
        throw new CancelError("Meeting is already cancelled.", 400);
      }

      // The cron flips these to Completed once it ticks; don't let the lag
      // allow cancelling something that is already over.
      if (
        isMeetingEnded(existingMeeting.meeting_date, existingMeeting.end_time)
      ) {
        throw new CancelError(
          "Meetings that have already ended cannot be cancelled.",
          400
        );
      }

      await tx
        .update(meeting)
        .set({
          meetingStatusId: MEETING_STATUS.CANCELLED,
          updated_at: new Date(),
        })
        .where(eq(meeting.meeting_id, meetingId));

      await createAuditLog(
        meetingId,
        AUDIT_ACTION.CANCELLED,
        "Meeting cancelled",
        organizer.employeeId,
        tx
      );

      return queueMeetingNotification(tx, meetingId, "CANCELLED");
    });

    dispatchNotification(notificationId);

    return NextResponse.json(
      {
        success: true,
        message: "Meeting cancelled successfully.",
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    if (error instanceof CancelError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
