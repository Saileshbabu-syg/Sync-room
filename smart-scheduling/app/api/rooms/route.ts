import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { room } from "@/db/schema/rooms";
import { like } from "drizzle-orm";
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const facility = searchParams.get("facility");

  if (facility) {
    const filteredRooms = await db
      .select()
      .from(room)
      .where(like(room.facilities, `%${facility}%`));

    return NextResponse.json(filteredRooms);
  }

  const allRooms = await db.select().from(room);

  return NextResponse.json(allRooms);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const newRoom = await db
      .insert(room)
      .values({
        room_name: body.roomName,
        room_capacity: body.roomCapacity,
        roomLocation: body.roomLocation,
        facilities: body.facilities,
        availabilityStatusId: body.availabilityStatusId,
        roomDescription: body.roomDescription,
      })
      .returning();

    return NextResponse.json(newRoom, {
      status: 201,
    });

  } catch (error) {
    return NextResponse.json(
      {
        message: "Failed to create room",
      },
      {
        status: 500,
      }
    );
  }
}

