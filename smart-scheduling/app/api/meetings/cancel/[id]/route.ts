import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db";

import { meeting } from "@/db/schema";

import { eq } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      id: string;
    }>;
  }
) {
  try {
    const { id } = await params;

    const meetingId = Number(id);

    if (isNaN(meetingId)) {
      return NextResponse.json(
        {
          message: "Invalid meeting id.",
        },
        {
          status: 400,
        }
      );
    }

    // Check meeting exists

    const existingMeeting =
      await db.query.meeting.findFirst({
        where: eq(
          meeting.meeting_id,
          meetingId
        ),
      });

    if (!existingMeeting) {
      return NextResponse.json(
        {
          message: "Meeting not found.",
        },
        {
          status: 404,
        }
      );
    }

    // Completed Meeting

    if (
      existingMeeting.meetingStatusId === 2
    ) {
      return NextResponse.json(
        {
          message:
            "Completed meetings cannot be cancelled.",
        },
        {
          status: 400,
        }
      );
    }

    // Already Cancelled

    if (
      existingMeeting.meetingStatusId === 3
    ) {
      return NextResponse.json(
        {
          message:
            "Meeting is already cancelled.",
        },
        {
          status: 400,
        }
      );
    }

    // Update Status

    await db
      .update(meeting)
      .set({
        meetingStatusId: 3,
        updated_at: new Date(),
      })
      .where(
        eq(
          meeting.meeting_id,
          meetingId
        )
      );

    return NextResponse.json(
      {
        success: true,
        message:
          "Meeting cancelled successfully.",
      },
      {
        status: 200,
      }
    );
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