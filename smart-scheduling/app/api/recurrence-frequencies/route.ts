import { NextResponse } from "next/server";

import { db } from "@/db";
import { recurrence_frequency_master } from "@/db/schema";
import { getCurrentOrganizer } from "@/lib/auth-helpers";

export async function GET() {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const data = await db.select().from(recurrence_frequency_master);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch recurrence frequencies",
      },
      {
        status: 500,
      }
    );
  }
}
