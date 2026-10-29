import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { availabilityMaster, room } from "@/db/schema";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  dbErrorCode,
  guardMutation,
  jsonError,
  parseIdParam,
  PG_FOREIGN_KEY_VIOLATION,
  readJson,
} from "@/lib/api";
import { ROLE_ADMIN } from "@/lib/constants";
import { roomBodySchema } from "@/lib/validations/room.validator";

type Context = { params: Promise<{ room_id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const roomId = parseIdParam((await params).room_id);

    if (roomId === null) {
      return jsonError(400, "Invalid room id.");
    }

    const roomData = await db
      .select()
      .from(room)
      .where(eq(room.room_id, roomId));

    if (roomData.length === 0) {
      return jsonError(404, "Room not found.");
    }

    return NextResponse.json(roomData[0]);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        message: "Failed to fetch room",
      },
      {
        status: 500,
      }
    );
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (organizer.role !== ROLE_ADMIN) {
      return NextResponse.json(
        { message: "Only Admin can update rooms." },
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

    const data = parsed.data;

    const [status] = await db
      .select({ id: availabilityMaster.availabilityStatusId })
      .from(availabilityMaster)
      .where(eq(availabilityMaster.availabilityStatusId, data.availabilityStatusId));

    if (!status) {
      return jsonError(400, "Invalid availability status.");
    }

    const updatedRoom = await db
      .update(room)
      .set({
        room_name: data.roomName,
        room_capacity: data.roomCapacity,
        roomLocation: data.roomLocation,
        facilities: data.facilities,
        availabilityStatusId: data.availabilityStatusId,
        roomDescription: data.roomDescription,
        updated_at: new Date(),
      })
      .where(eq(room.room_id, roomId))
      .returning();

    if (updatedRoom.length === 0) {
      return jsonError(404, "Room not found.");
    }

    return NextResponse.json(updatedRoom);
  } catch (error) {
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

    if (organizer.role !== ROLE_ADMIN) {
      return NextResponse.json(
        { message: "Only Admin can delete rooms." },
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
        "This room has meetings and cannot be deleted."
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
