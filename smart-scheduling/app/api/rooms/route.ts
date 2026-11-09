import { NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, readJson } from "@/lib/api";
import { canManageRooms } from "@/lib/services/group-context.service";
import { RoomError, createRoom, listRoomsFor } from "@/lib/services/room.service";
import { roomBodySchema } from "@/lib/validations/room.validator";

// The rooms the signed-in person may see: room managers every room
// (`?archived=1` adds archived ones), everyone else the active rooms their
// group may book. `?facility=` filters by a facility (substring).
export async function GET(request: Request) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const facility = searchParams.get("facility")?.trim().slice(0, 100) || undefined;

    const { rooms } = await listRoomsFor(
      { employeeId: organizer.employeeId, role: organizer.role },
      { facility, includeArchived: searchParams.get("archived") === "1" }
    );

    // The same row shape as before (statusCode is only for the Rooms page).
    return NextResponse.json(
      rooms.map((r) => {
        const row: Partial<typeof r> = { ...r };

        delete row.statusCode;

        return row;
      })
    );
  } catch (error) {
    console.error(error);

    return jsonError(500, "Failed to load rooms.");
  }
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
    if (!(await canManageRooms(organizer.employeeId, organizer.role))) {
      return NextResponse.json(
        { message: "You do not have permission to create rooms." },
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

    const newRoom = await createRoom(parsed.data);

    return NextResponse.json([newRoom], {
      status: 201,
    });

  } catch (error) {
    if (error instanceof RoomError) return jsonError(error.status, error.message);

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
