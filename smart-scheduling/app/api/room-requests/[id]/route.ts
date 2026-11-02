import { NextRequest, NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
  readJson,
} from "@/lib/api";
import { roomRequestDecisionSchema } from "@/lib/validations/room-request.validator";
import { BookingError } from "@/lib/services/booking.service";
import {
  type ApproveOutcome,
  approveRoomRequest,
  cancelRoomRequest,
  rejectRoomRequest,
  releaseAndBook,
  RoomRequestError,
} from "@/lib/services/room-request.service";

// What the organizer is told after approving or releasing.
function outcomeBody(result: ApproveOutcome) {
  switch (result.outcome) {
    case "booked":
      return {
        outcome: result.outcome,
        meetingId: result.meetingId,
        message: "Approved. The room is now booked for the requester.",
      };

    case "waiting_others":
      return {
        outcome: result.outcome,
        message:
          "Your approval is recorded. Other organizers with a booking in that room still need to answer; the room is booked only when everyone agrees and it is free.",
      };

    case "awaiting_slot":
      return {
        outcome: result.outcome,
        message:
          "Approval recorded. A booking still holds the room, so nothing was booked yet. It is booked automatically as soon as every booking in the way is cancelled or released.",
      };

    case "failed":
      return {
        outcome: result.outcome,
        message: `Everyone agreed, but the room could not be booked: ${result.message} Nothing was booked.`,
      };
  }
}

// The decision endpoint. It is a POST-style state change (PATCH) that goes
// through the app's usual origin / content-type guard, needs a signed-in user,
// and the service checks that this user is the organizer of the booked meeting
// (approve, reject, release) or the requester (cancel). Opening a link from an
// e-mail only shows the review page; nothing is decided until this is called.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentOrganizer();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const blocked =
      guardMutation(req) ?? rateLimit(user.employeeId, "room-request-answer", 30);

    if (blocked) return blocked;

    const requestId = parseIdParam((await params).id);

    if (requestId === null) return jsonError(400, "Invalid request id.");

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const parsed = roomRequestDecisionSchema.safeParse(body.data);

    if (!parsed.success) {
      return NextResponse.json(
        { message: "Validation failed", errors: parsed.error.issues },
        { status: 400 }
      );
    }

    const decision = parsed.data;

    switch (decision.action) {
      case "approve": {
        const result = await approveRoomRequest(requestId, user.employeeId, {
          releaseBooking: decision.release_booking === true,
        });

        return NextResponse.json(outcomeBody(result));
      }

      case "release": {
        const result = await releaseAndBook(requestId, user.employeeId);

        return NextResponse.json(outcomeBody(result));
      }

      case "reject":
        await rejectRoomRequest(requestId, user.employeeId, decision.reason);
        return NextResponse.json({ message: "Request rejected." });

      case "cancel":
        await cancelRoomRequest(requestId, user.employeeId);
        return NextResponse.json({ message: "Request cancelled." });
    }
  } catch (error) {
    if (error instanceof RoomRequestError || error instanceof BookingError) {
      return NextResponse.json(
        { message: error.message },
        { status: error.status }
      );
    }

    console.error(error);

    return jsonError(500, "Something went wrong");
  }
}
