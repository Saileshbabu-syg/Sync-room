import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { room } from "@/db/schema";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  dbErrorCode,
  guardMutation,
  jsonError,
  parseIdParam,
  PG_FOREIGN_KEY_VIOLATION,
  readJson,
} from "@/lib/api";
import { canManageRooms } from "@/lib/services/group-context.service";
import { RoomError, updateRoom } from "@/lib/services/room.service";
import { roomBodySchema } from "@/lib/validations/room.validator";

type Context = { params: Promise<{ room_id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!(await canManageRooms(organizer.employeeId, organizer.role))) {
      return NextResponse.json(
        { message: "You do not have permission to update rooms." },
        { status: 403 }
      );
    }

    const blocked = guardMutation(request);

    if (blocked) return blocked;

    const roomId = parseIdParam((await params).room_id);

    if (roomId === null) {
      return jsonError(400, "Invalid room id.");
    }

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = roomBodySchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(
        400,
        parsed.error.issues[0]?.message ?? "Validation failed"
      );
    }

    // The same update (and checks) as the room edit form's route.
    const updatedRoom = await updateRoom(roomId, parsed.data);

    return NextResponse.json([updatedRoom]);
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
        message: "Failed to update room",
      },
      {
        status: 500,
      }
    );
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!(await canManageRooms(organizer.employeeId, organizer.role))) {
      return NextResponse.json(
        { message: "You do not have permission to delete rooms." },
        { status: 403 }
      );
    }

    const blocked = guardMutation(request, { expectJson: false });

    if (blocked) return blocked;

    const roomId = parseIdParam((await params).room_id);

    if (roomId === null) {
      return jsonError(400, "Invalid room id.");
    }

    const deletedRoom = await db
      .delete(room)
      .where(eq(room.room_id, roomId))
      .returning();

    if (deletedRoom.length === 0) {
      return jsonError(404, "Room not found.");
    }

    return NextResponse.json(deletedRoom);
  } catch (error) {
    // Rooms that still have meetings are protected by a foreign key.
    if (dbErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) {
      return jsonError(
        409,
        "This room has meetings and cannot be deleted. Archive it instead."
      );
    }

    console.error(error);

    return NextResponse.json(
      {
        message: "Failed to delete room",
      },
      {
        status: 500,
      }
    );
  }
}
