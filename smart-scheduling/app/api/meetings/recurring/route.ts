import { NextRequest, NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";

import { recurringMeetingSchema } from "@/lib/validations/recurring-meeting";

import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { BookingError } from "@/lib/services/booking.service";

export async function POST(req: NextRequest) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const blocked =
      guardMutation(req) ?? rateLimit(organizer.employeeId, "recurring", 10);

    if (blocked) return blocked;

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const result = recurringMeetingSchema.safeParse(body.data);

    if (!result.success) {
      return NextResponse.json(
        {
          message: "Validation failed",
          errors: result.error.issues,
        },
        { status: 400 }
      );
    }

    // The organizer and their role are always the signed-in user, never
    // whatever the client sends — otherwise any caller could book meetings as
    // any employee.
    const { meetings, recurringMeetingId } = await createRecurringMeeting({
      ...result.data,
      organizerEmployeeId: organizer.employeeId,
      organizerRole: organizer.role,
    });

    return NextResponse.json(
      {
        success: true,
        data: meetings,
        recurringMeetingId,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof BookingError) {
      return NextResponse.json(
        {
          success: false,
          message: error.message,
          ...(error.conflicts ? { conflicts: error.conflicts } : {}),
        },
        { status: error.status }
      );
    }

    console.error(error);

    return jsonError(500, "Failed to create recurring meeting");
  }
}
