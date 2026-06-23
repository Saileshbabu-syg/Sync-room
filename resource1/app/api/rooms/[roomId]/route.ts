    import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { rooms } from "@/db/schema/rooms";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;

    const roomData = await db
      .select()
      .from(rooms)
      .where(eq(rooms.roomId, Number(roomId)));

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
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const body = await request.json();

    const { roomId } = await params;

    const updatedRoom = await db
      .update(rooms)
      .set({
        roomName: body.roomName,
        roomCapacity: body.roomCapacity,
        roomLocation: body.roomLocation,
        facilities: body.facilities,
        availabilityStatusId: body.availabilityStatusId,
        roomDescription: body.roomDescription,
      })
      .where(eq(rooms.roomId, Number(roomId)))
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
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;

    const deletedRoom = await db
      .delete(rooms)
      .where(eq(rooms.roomId, Number(roomId)))
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