import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db";

import { room } from "@/db/schema";

import {
  getAvailableRooms,
  isRoomAvailable,
} from "@/lib/services/room-suggestion.service";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { jsonError, rateLimit, readJson } from "@/lib/api";
import { suggestionsSchema } from "@/lib/validations/suggestions.validator";

import { desc } from "drizzle-orm";

export async function POST(
  req: NextRequest
) {
  try {

    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const limited = rateLimit(organizer.employeeId, "suggestions", 60);

    if (limited) return limited;

    const body = await readJson(req);

    if (!body.ok) return body.response;

    // Same rules as booking: real dates/times, not in the past, within the
    // booking window, and at least 15 minutes long.
    const parsed = suggestionsSchema.safeParse(body.data);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          message: parsed.error.issues[0]?.message ?? "Validation failed",
          errors: parsed.error.issues,
        },
        { status: 400 }
      );
    }

    const {
      room_id,
      meeting_date,
      start_time,
      end_time,
      participant_count,
    } = parsed.data;

    // -------------------------------
    // Booking from Room Details Page
    // -------------------------------

    if (room_id) {

      const available =
        await isRoomAvailable(
          room_id,
          meeting_date,
          start_time,
          end_time,
          participant_count
        );

      if (!available.success) {

        return NextResponse.json(
          available,
          {
            status: 400,
          }
        );

      }

      return NextResponse.json(
        available,
        {
          status: 200,
        }
      );

    }

    // -------------------------------
    // Booking from Book Meeting Page
    // -------------------------------

    const availableRooms =
      await getAvailableRooms(
        meeting_date,
        start_time,
        end_time,
        participant_count
      );

    // Get Maximum Room Capacity

    const maxRoom = await db
      .select({
        capacity: room.room_capacity,
      })
      .from(room)
      .orderBy(
        desc(room.room_capacity)
      )
      .limit(1);

    return NextResponse.json({

      success: true,

      data: availableRooms,

      maxCapacity:
        maxRoom[0]?.capacity ?? 0,

    });

  } catch (error) {

    console.error(error);

    return jsonError(500, "Failed to fetch room suggestions");

  }

}
