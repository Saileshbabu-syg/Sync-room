import { NextRequest, NextResponse } from "next/server";

import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
  readJson,
} from "@/lib/api";
import { editSeries, lifecycleError } from "@/lib/services/series.service";

// Edits a meeting (title, headcount, type, attendees, and for a series the
// room / time of day). `scope` chooses, for an occurrence of a recurring
// series, "single" (this occurrence), "following" (this and later ones) or
// "series" (every upcoming occurrence). Only the organizer or an Admin may
// (checked in the service, under the row locks).
export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
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
      guardMutation(req) ?? rateLimit(organizer.employeeId, "edit", 30);

    if (blocked) return blocked;

    const { id } = await params;

    const meetingId = parseIdParam(id);

    if (meetingId === null) {
      return jsonError(400, "Invalid meeting id.");
    }

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const result = editMeetingSchema.safeParse(body.data);

    if (!result.success) {
      return NextResponse.json(
        {
          message: "Validation failed",
          errors: result.error.issues,
        },
        {
          status: 400,
        }
      );
    }

    const { scope, room_id, start_time, end_time, ...details } = result.data;

    const { changedMeetingIds } = await editSeries({
      meetingId,
      scope,
      actor: { employeeId: organizer.employeeId, role: organizer.role },
      details,
      slot:
        room_id !== undefined || start_time !== undefined
          ? { roomId: room_id, startTime: start_time, endTime: end_time }
          : undefined,
    });

    return NextResponse.json(
      {
        success: true,
        message:
          changedMeetingIds.length > 1
            ? `${changedMeetingIds.length} meetings updated successfully.`
            : "Meeting updated successfully.",
        updatedMeetingIds: changedMeetingIds,
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    const known = lifecycleError(error);

    if (known) return jsonError(known.status, known.message);

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
