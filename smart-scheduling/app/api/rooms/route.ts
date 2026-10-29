import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { availabilityMaster, room } from "@/db/schema";
import { like } from "drizzle-orm";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, readJson } from "@/lib/api";
import { ROLE_ADMIN } from "@/lib/constants";
import { roomBodySchema } from "@/lib/validations/room.validator";

export async function GET(request: Request) {
  const organizer = await getCurrentOrganizer();

  if (!organizer) {
    return NextResponse.json(
      { message: "Unauthorized" },
      { status: 401 }
    );
  }

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
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    // Current role, re-read from the Employee record on every request.
    if (organizer.role !== ROLE_ADMIN) {
      return NextResponse.json(
        { message: "Only Admin can create rooms." },
        { status: 403 }
      );
    }

    const blocked = guardMutation(request);

    if (blocked) return blocked;

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

    const newRoom = await db
      .insert(room)
      .values({
        room_name: data.roomName,
        room_capacity: data.roomCapacity,
        roomLocation: data.roomLocation,
        facilities: data.facilities,
        availabilityStatusId: data.availabilityStatusId,
        roomDescription: data.roomDescription,
      })
      .returning();

    return NextResponse.json(newRoom, {
      status: 201,
    });

  } catch (error) {
    console.error(error);

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
