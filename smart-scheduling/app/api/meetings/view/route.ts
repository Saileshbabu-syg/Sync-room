import { NextResponse } from "next/server";
import { auth } from "@/auth";

import { db } from "@/db";

import { meeting } from "@/db/schema";
import { organizers } from "@/db/schema";
import { room } from "@/db/schema";
import { meetingTypes } from "@/db/schema";
import { meetingStatuses } from "@/db/schema";

import {
  eq,
  desc,
} from "drizzle-orm";

export async function GET() {
  try {

    const session = await auth();

    if (!session) {
      return NextResponse.json(
        {
          message: "Unauthorized",
        },
        {
          status: 401,
        }
      );
    }

    const organizer = await db
      .select()
      .from(organizers)
      .where(
        eq(
          organizers.email,
          session.user!.email!
        )
      );

    if (organizer.length === 0) {
      return NextResponse.json(
        {
          message: "Organizer not found",
        },
        {
          status: 404,
        }
      );
    }

    const meetingList = await db
      .select({
        meetingId: meeting.meeting_id,

        title: meeting.title,

        meetingDate: meeting.meeting_date,

        startTime: meeting.start_time,

        endTime: meeting.end_time,

        participantCount:
          meeting.participantCount,

        roomName: room.room_name,

        meetingType:
          meetingTypes.meetingTypeName,

        meetingStatus:
          meetingStatuses.meetingStatusName,
      })

      .from(meeting)

      .leftJoin(
        room,
        eq(room.room_id, meeting.room_id)
      )

      .leftJoin(
        meetingTypes,
        eq(
          meetingTypes.meetingTypeId,
          meeting.meetingTypeId
        )
      )

      .leftJoin(
        meetingStatuses,
        eq(
          meetingStatuses.meetingStatusId,
          meeting.meetingStatusId
        )
      )

      .where(
        eq(
          meeting.organizerEmployeeId,
          organizer[0].employeeId
        )
      )

      .orderBy(
        desc(meeting.meeting_date)
      );

    return NextResponse.json(
      meetingList,
      {
        status: 200,
      }
    );

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        message: "Something went wrong",
      },
      {
        status: 500,
      }
    );

  }
}