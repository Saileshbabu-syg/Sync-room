import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db";

import { room } from "@/db/schema/rooms";

import {
  getAvailableRooms,
  isRoomAvailable,
} from "@/lib/services/room-suggestion.service";

import { desc } from "drizzle-orm";

export async function POST(
  req: NextRequest
) {
  try {

    const body = await req.json();

    const {
      room_id,
      meeting_date,
      start_time,
      end_time,
      participant_count,
    } = body;

    if (
  participant_count === undefined ||
  participant_count < 1
) {
  return NextResponse.json(
    {
      success: false,
      message:
        "Participant count must be at least 1.",
    },
    {
      status: 400,
    }
  );
}

const start = new Date(
  `${meeting_date}T${start_time}`
);

const end = new Date(
  `${meeting_date}T${end_time}`
);

const duration =
  (end.getTime() - start.getTime()) / 60000;

if (duration < 15) {
  return NextResponse.json(
    {
      success: false,
      message:
        "Meeting duration must be at least 15 minutes.",
    },
    {
      status: 400,
    }
  );
}

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

    return NextResponse.json(
      {
        success: false,
        message:
          "Failed to fetch room suggestions",
      },
      {
        status: 500,
      }
    );

  }

}