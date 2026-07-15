import { NextRequest, NextResponse } from "next/server";

import {
  getAvailableRooms,
  isRoomAvailable,
} from "@/lib/services/room-suggestion.service";

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

    // Booking from Rooms module
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

    // Booking from Book Meeting module

    const availableRooms =
      await getAvailableRooms(
        meeting_date,
        start_time,
        end_time,
        participant_count
      );

    return NextResponse.json({
      success: true,
      data: availableRooms,
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