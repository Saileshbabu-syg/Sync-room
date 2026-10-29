import { NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { getAllowedMeetingTypes } from "@/lib/services/meeting-type-access.service";

export async function GET() {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    // Only the types the caller's current role may book — the same list the
    // booking and edit endpoints enforce.
    const data = await getAllowedMeetingTypes(organizer.role);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to fetch meeting types",
      },
      {
        status: 500,
      }
    );
  }
}
