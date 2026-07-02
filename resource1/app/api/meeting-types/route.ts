import { NextResponse } from "next/server";
import { db } from "@/db";
import { meetingTypes } from "@/db/schema/meetingTypes";

export async function GET() {
  try {
    const data = await db
      .select()
      .from(meetingTypes);

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { message: "Error fetching meeting types" },
      { status: 500 }
    );
  }
}