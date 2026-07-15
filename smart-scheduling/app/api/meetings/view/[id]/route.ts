import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

import { db } from "@/db";

import { meeting } from "@/db/schema/meeting";
import { organizers } from "@/db/schema/organizer";
import { room } from "@/db/schema/rooms";
import { meetingTypes } from "@/db/schema/meetingTypes";
import { meetingStatuses } from "@/db/schema/meetingStatuses";
import { meeting_attendees } from "@/db/schema/meeting_attendees";
import { employee } from "@/db/schema/employee";

import {
  and,
  eq,
  ne,
} from "drizzle-orm";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(
  request: NextRequest,
  { params }: Props
) {
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

    const { id } = await params;

    // Logged in Organizer
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

    // Meeting Details
    const meetingData = await db
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

        organizerEmployeeId:
          meeting.organizerEmployeeId,
      })
      .from(meeting)

      .leftJoin(
        room,
        eq(
          room.room_id,
          meeting.room_id
        )
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
          meeting.meeting_id,
          Number(id)
        )
      );

    if (meetingData.length === 0) {
      return NextResponse.json(
        {
          message: "Meeting not found",
        },
        {
          status: 404,
        }
      );
    }

    // Organizer Details
    const organizerDetails = await db
      .select({
        employeeId: employee.employee_id,

        employeeName:
          employee.employee_name,
      })
      .from(employee)
      .where(
        eq(
          employee.employee_id,
          meetingData[0].organizerEmployeeId
        )
      );

    // Attendees (excluding organizer)
    const attendees = await db
      .select({
        employeeId: employee.employee_id,

        employeeName:
          employee.employee_name,
      })
      .from(meeting_attendees)

      .leftJoin(
        employee,
        eq(
          employee.employee_id,
          meeting_attendees.employee_id
        )
      )

      .where(
        and(
          eq(
            meeting_attendees.meeting_id,
            Number(id)
          ),
          ne(
            meeting_attendees.employee_id,
            meetingData[0].organizerEmployeeId
          )
        )
      );

    return NextResponse.json(
      {
        ...meetingData[0],

        organizer:
          organizerDetails[0],

        attendees,
      },
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