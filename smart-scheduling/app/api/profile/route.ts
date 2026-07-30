import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { organizers } from "@/db/schema/organizer";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const organizerId = Number(
      searchParams.get("organizerId")
    );

    if (!organizerId) {
      return NextResponse.json(
        { message: "Organizer Id is required" },
        { status: 400 }
      );
    }

    const organizer = await db
      .select({
        organizerId: organizers.organizerId,
        employeeId: organizers.employeeId,
        name: organizers.name,
        email: organizers.email,
        role: organizers.role,
      })
      .from(organizers)
      .where(eq(organizers.organizerId, organizerId));

    if (organizer.length === 0) {
      return NextResponse.json(
        { message: "Organizer not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(organizer[0]);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { message: "Something went wrong" },
      { status: 500 }
    );
  }
}