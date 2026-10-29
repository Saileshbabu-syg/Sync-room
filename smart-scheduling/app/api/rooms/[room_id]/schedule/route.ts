import { NextRequest, NextResponse } from "next/server";

import { getRoomSchedule } from "@/lib/services/room-suggestion.service";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { jsonError, parseIdParam } from "@/lib/api";
import {
  DATE_REGEX,
  isValidCalendarDate,
} from "@/lib/validations/date-time";

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

    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const roomId = parseIdParam((await params).room_id);

    if (roomId === null) {
      return jsonError(400, "Invalid room id.");
    }

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

    if (!DATE_REGEX.test(date) || !isValidCalendarDate(date)) {
      return jsonError(400, "date must be a valid YYYY-MM-DD date.");
    }

    // Titles of meetings the caller is not part of are returned as "Busy".
    const schedule =
      await getRoomSchedule(roomId, date, {
        employeeId: organizer.employeeId,
        role: organizer.role,
      });

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
