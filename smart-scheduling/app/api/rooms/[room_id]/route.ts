    import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { room } from "@/db/schema";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id } = await params;

    const roomData = await db
      .select()
      .from(room)
      .where(eq(room.room_id, Number(room_id)));

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const body = await request.json();

    const { room_id } = await params;

    const updatedRoom = await db
      .update(room)
      .set({
        room_name: body.roomName,
        room_capacity: body.roomCapacity,
        roomLocation: body.roomLocation,
        facilities: body.facilities,
        availabilityStatusId: body.availabilityStatusId,
        roomDescription: body.roomDescription,
      })
      .where(eq(room.room_id, Number(room_id)))
      .returning();

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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id } = await params;

    const deletedRoom = await db
      .delete(room)
      .where(eq(room.room_id, Number(room_id)))
      .returning();

    return NextResponse.json(deletedRoom);
  } catch (error) {
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