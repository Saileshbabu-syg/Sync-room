import { NextRequest, NextResponse } from "next/server";

import { createMeetingSchema } from "@/lib/validations/meeting.validator";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import { BookingError, createBooking } from "@/lib/services/booking.service";

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
      guardMutation(req) ?? rateLimit(organizer.employeeId, "booking", 20);

    if (blocked) return blocked;

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const result = createMeetingSchema.safeParse(body.data);

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

    const validatedData = result.data;

    // The organizer (and their role) is always the signed-in user, never
    // whatever the client sends — otherwise any caller could book meetings as
    // any employee. Conflicts, room availability, capacity, role→meeting-type
    // rules and all inserts happen inside createBooking's single transaction.
    const { meetings } = await createBooking({
      title: validatedData.title,
      roomId: validatedData.room_id,
      occurrenceDates: [validatedData.meeting_date],
      startTime: validatedData.start_time,
      endTime: validatedData.end_time,
      organizerEmployeeId: organizer.employeeId,
      organizerRole: organizer.role,
      participantCount: validatedData.participant_count,
      meetingTypeId: validatedData.meeting_type_id,
      participantEmployeeIds: validatedData.participantEmployeeIds,
    });

    return NextResponse.json(
      {
        message: "Validation successful",
        meetingId: meetings[0].meeting_id,
        data: validatedData,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof BookingError) {
      return NextResponse.json(
        {
          message: error.message,
          ...(error.conflicts ? { conflicts: error.conflicts } : {}),
        },
        { status: error.status }
      );
    }

    console.error(error);

    return jsonError(500, "Something went wrong");
  }
}
