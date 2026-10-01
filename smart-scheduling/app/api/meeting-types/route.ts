import { NextResponse } from "next/server";

import { db } from "@/db";
import { meetingTypes } from "@/db/schema";

export async function GET() {
  try {
    const data = await db
      .select()
      .from(meetingTypes);

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