    import { NextResponse } from "next/server";

import { db } from "@/db";
import { meetingStatuses } from "@/db/schema/meetingStatuses";

export async function GET() {
  try {
    const data = await db
      .select()
      .from(meetingStatuses);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch meeting statuses",
      },
      {
        status: 500,
      }
    );
  }
}