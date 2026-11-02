import { NextRequest, NextResponse } from "next/server";

import { createMeetingSchema } from "@/lib/validations/meeting.validator";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import {
  BookingError,
  createBooking,
  SLOT_TAKEN_MESSAGE,
} from "@/lib/services/booking.service";
import { describeConflict } from "@/lib/services/room-request.service";

export async function POST(req: NextRequest) {
  // Remembered so a "slot taken" answer can say what is in the way.
  let slot:
    | { roomId: number; date: string; start: string; end: string }
    | undefined;
  let viewer: { employeeId: number; role: string } | undefined;

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

    slot = {
      roomId: validatedData.room_id,
      date: validatedData.meeting_date,
      start: validatedData.start_time,
      end: validatedData.end_time,
    };
    viewer = { employeeId: organizer.employeeId, role: organizer.role };

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
      // The slot is taken: say by whom (as far as this user may see), and
      // whether they can ask for it. Nothing is booked either way.
      const conflict =
        error.status === 409 &&
        error.message === SLOT_TAKEN_MESSAGE &&
        slot &&
        viewer
          ? await describeConflict(
              slot.roomId,
              slot.date,
              slot.start,
              slot.end,
              viewer
            ).catch(() => undefined)
          : undefined;

      return NextResponse.json(
        {
          message: error.message,
          ...(error.conflicts ? { conflicts: error.conflicts } : {}),
          ...(conflict ? { conflict } : {}),
        },
        { status: error.status }
      );
    }

    console.error(error);

    return jsonError(500, "Something went wrong");
  }
}
