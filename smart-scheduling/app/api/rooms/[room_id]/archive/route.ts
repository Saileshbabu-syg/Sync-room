import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { guardMutation, jsonError, parseIdParam, readJson } from "@/lib/api";
import { canManageRooms } from "@/lib/services/group-context.service";
import { RoomError, setRoomArchived } from "@/lib/services/room.service";

const bodySchema = z.object({ archived: z.boolean() });

type Context = { params: Promise<{ room_id: string }> };

// Archives ({ archived: true }) or restores ({ archived: false }) a room.
// Archived rooms cannot be booked; meetings held in them keep their room.
// Refused with the list of upcoming meetings while any are booked in it.
// Room managers only (re-read from the database on every request).
export async function PATCH(request: Request, { params }: Context) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) return jsonError(401, "Unauthorized");

    if (!(await canManageRooms(organizer.employeeId, organizer.role))) {
      return jsonError(403, "You do not have permission to archive rooms.");
    }

    const blocked = guardMutation(request);

    if (blocked) return blocked;

    const roomId = parseIdParam((await params).room_id);

    if (roomId === null) return jsonError(400, "Invalid room id.");

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = bodySchema.safeParse(body.data);

    if (!parsed.success) return jsonError(400, "archived must be true or false.");

    const updated = await setRoomArchived(roomId, parsed.data.archived);

    return NextResponse.json({
      success: true,
      message: parsed.data.archived ? "Room archived." : "Room restored.",
      archived: updated.archived_at !== null,
    });
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

    return jsonError(500, "Something went wrong.");
  }
}
