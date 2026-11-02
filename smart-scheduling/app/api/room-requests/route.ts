import { NextRequest, NextResponse } from "next/server";

import { createMeetingSchema } from "@/lib/validations/meeting.validator";
import { roomRequestExtrasSchema } from "@/lib/validations/room-request.validator";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import {
  createRoomRequest,
  describeConflict,
  RoomRequestError,
} from "@/lib/services/room-request.service";
import { DATE_REGEX, TIME_REGEX } from "@/lib/validations/date-time";
import { z } from "zod";

const conflictQuerySchema = z.object({
  room_id: z.coerce.number().int().positive(),
  meeting_date: z.string().regex(DATE_REGEX),
  start_time: z.string().regex(TIME_REGEX),
  end_time: z.string().regex(TIME_REGEX),
});

// Read-only: what is in the way of this room and time, and whether it can be
// requested. Used by the booking screen for one date of a recurring series.
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentOrganizer();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const limited = rateLimit(user.employeeId, "room-request-info", 60);

    if (limited) return limited;

    const query = conflictQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    );

    if (!query.success) return jsonError(400, "Invalid room, date or time.");

    const { room_id, meeting_date, start_time, end_time } = query.data;

    return NextResponse.json({
      conflict: await describeConflict(room_id, meeting_date, start_time, end_time, {
        employeeId: user.employeeId,
        role: user.role,
      }),
    });
  } catch (error) {
    console.error(error);

    return jsonError(500, "Something went wrong");
  }
}

// Asks the organizer of a booked meeting for its room. The body is the meeting
// the requester wants (the same fields as a normal booking) plus their
// message; it is booked only after the organizer agrees AND the room is free.
// Who is asked, which booking is in the way and the status are decided on the
// server from the room and time - never from the request.
export async function POST(req: NextRequest) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const blocked =
      guardMutation(req) ?? rateLimit(organizer.employeeId, "room-request", 20);

    if (blocked) return blocked;

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const meeting = createMeetingSchema.safeParse(body.data);
    const extras = roomRequestExtrasSchema.safeParse(body.data);

    if (!meeting.success || !extras.success) {
      return NextResponse.json(
        {
          // The first problem, in words (for example a date in the past).
          message:
            (!meeting.success ? meeting.error.issues[0]?.message : undefined) ??
            (!extras.success ? extras.error.issues[0]?.message : undefined) ??
            "Validation failed",
          errors: [
            ...(meeting.success ? [] : meeting.error.issues),
            ...(extras.success ? [] : extras.error.issues),
          ],
        },
        { status: 400 }
      );
    }

    const data = meeting.data;

    // The requester is always the signed-in user.
    const { request, created } = await createRoomRequest({
      requesterEmployeeId: organizer.employeeId,
      requesterRole: organizer.role,
      roomId: data.room_id,
      meetingDate: data.meeting_date,
      startTime: data.start_time,
      endTime: data.end_time,
      title: data.title,
      message: extras.data.message,
      participantCount: data.participant_count,
      meetingTypeId: data.meeting_type_id,
      participantEmployeeIds: data.participantEmployeeIds,
      clientRequestId: extras.data.client_request_id,
    });

    return NextResponse.json(
      {
        message: created ? "Request sent" : "Request already sent",
        requestId: request.room_request_id,
        status: request.status,
      },
      { status: created ? 201 : 200 }
    );
  } catch (error) {
    if (error instanceof RoomRequestError) {
      return NextResponse.json(
        { message: error.message },
        { status: error.status }
      );
    }

    console.error(error);

    return jsonError(500, "Something went wrong");
  }
}
