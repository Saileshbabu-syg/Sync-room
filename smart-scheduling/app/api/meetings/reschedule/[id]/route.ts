import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
  readJson,
} from "@/lib/api";
import {
  meetingDateField,
  timeFields,
} from "@/lib/validations/meeting.validator";
import {
  LEAD_TIME_MESSAGE,
  MIN_DURATION_MESSAGE,
  hasMinimumLead,
  isLongEnough,
} from "@/lib/validations/date-time";
import {
  RescheduleError,
  rescheduleMeeting,
} from "@/lib/services/reschedule.service";

const rescheduleSchema = z
  .object({
    room_id: z.number().int().positive(),
    meeting_date: meetingDateField,
    ...timeFields,
  })
  .refine((data) => data.start_time !== data.end_time, {
    message: "End time must be different from the start time",
    path: ["end_time"],
  })
  .refine((data) => isLongEnough(data.start_time, data.end_time), {
    message: MIN_DURATION_MESSAGE,
    path: ["end_time"],
  })
  .refine((data) => hasMinimumLead(data.meeting_date, data.start_time), {
    message: LEAD_TIME_MESSAGE,
    path: ["start_time"],
  });

// Moves a meeting to another room, date or time: a scheduled meeting (B-04),
// or one bumped by a higher-priority booking (status Pending reschedule). Only
// the organizer or an Admin (checked in the service, under the locks).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const blocked =
      guardMutation(req) ?? rateLimit(organizer.employeeId, "reschedule", 20);

    if (blocked) return blocked;

    const { id } = await params;
    const meetingId = parseIdParam(id);

    if (meetingId === null) {
      return jsonError(400, "Invalid meeting id.");
    }

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const result = rescheduleSchema.safeParse(body.data);

    if (!result.success) {
      return NextResponse.json(
        { message: "Validation failed", errors: result.error.issues },
        { status: 400 }
      );
    }

    await rescheduleMeeting({
      meetingId,
      actor: { employeeId: organizer.employeeId, role: organizer.role },
      roomId: result.data.room_id,
      meetingDate: result.data.meeting_date,
      startTime: result.data.start_time,
      endTime: result.data.end_time,
    });

    return NextResponse.json(
      { success: true, message: "Meeting rescheduled successfully." },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof RescheduleError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
