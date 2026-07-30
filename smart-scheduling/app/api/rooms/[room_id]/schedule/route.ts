import { NextRequest, NextResponse } from "next/server";

import { getRoomSchedule } from "@/lib/services/room-suggestion.service";

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      room_id: string;
    }>;
  }
) {
  try {

    const { room_id } = await params;

    const searchParams =
      req.nextUrl.searchParams;

    const date =
      searchParams.get("date");

    if (!date) {
      return NextResponse.json(
        {
          message: "Date is required.",
        },
        {
          status: 400,
        }
      );
    }

    const schedule =
      await getRoomSchedule(
        Number(room_id),
        date
      );

    return NextResponse.json({
      success: true,
      data: schedule,
    });

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong.",
      },
      {
        status: 500,
      }
    );

  }
}