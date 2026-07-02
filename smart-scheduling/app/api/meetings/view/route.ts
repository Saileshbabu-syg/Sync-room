import { NextResponse } from "next/server";
import { db } from "@/db";
import { meeting } from "@/db/schema/meeting";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const organizerEmployeeId = 1; // Temporary until authentication

    const meetingList = await db.query.meeting.findMany({
      where: eq(
        meeting.organizerEmployeeId,
        organizerEmployeeId
      ),
    });

    return NextResponse.json(meetingList, { status: 200 });
  } catch {
    return NextResponse.json(
      { message: "Something went wrong" },
      { status: 500 }
    );
  }
}