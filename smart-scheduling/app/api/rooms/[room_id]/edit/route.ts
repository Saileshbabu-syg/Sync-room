import { NextRequest, NextResponse } from "next/server";

import { editRoomSchema } from "@/lib/validations/editRoom.validator";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  readJson,
} from "@/lib/api";
import { canManageRooms } from "@/lib/services/group-context.service";
import { RoomError, updateRoom } from "@/lib/services/room.service";

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      room_id: string;
    }>;
  }
) {
  try {

    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized.",
        },
        {
          status: 401,
        }
      );
    }

    // Admin status is checked against the Employee record on every request,
    // so a demoted admin loses this immediately.
    if (!(await canManageRooms(organizer.employeeId, organizer.role))) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to edit rooms.",
        },
        {
          status: 403,
        }
      );
    }

    const blocked = guardMutation(req);

    if (blocked) return blocked;

    const roomId = parseIdParam((await params).room_id);

    if (roomId === null) {
      return jsonError(400, "Invalid room id.");
    }

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const result =
      editRoomSchema.safeParse(body.data);

    if (!result.success) {

      return NextResponse.json(
        {
          success: false,
          message:
            result.error.issues[0]
              .message,
        },
        {
          status: 400,
        }
      );

    }

    const validatedData =
      result.data;

    // One update path for every room route (room.service): status check,
    // capacity guard and the maintenance guard (upcoming meetings).
    await updateRoom(roomId, {
      roomName: validatedData.room_name,
      roomCapacity: validatedData.room_capacity,
      roomLocation: validatedData.roomLocation,
      facilities: validatedData.facilities?.trim(),
      roomDescription: validatedData.roomDescription?.trim(),
      availabilityStatusId: validatedData.availabilityStatusId,
    });

    return NextResponse.json(
      {
        success: true,
        message:
          "Room updated successfully.",
      },
      {
        status: 200,
      }
    );

  } catch (error) {
    if (error instanceof RoomError) {
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

    return NextResponse.json(
      {
        success: false,
        message:
          "Something went wrong.",
      },
      {
        status: 500,
      }
    );

  }
}
