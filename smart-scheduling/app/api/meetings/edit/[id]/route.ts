import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db";

import { meeting } from "@/db/schema";
import { meetingTypes } from "@/db/schema";
import { room } from "@/db/schema";
import { employee } from "@/db/schema";
import { meeting_attendees } from "@/db/schema";

import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";

import { eq } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
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

    const body = await req.json();

    const result =
      editMeetingSchema.safeParse(body);

    if (!result.success) {
       console.log(result.error.issues);
      return NextResponse.json(
        {
          message: "Validation failed",
          errors: result.error.issues,
        },
        {
          status: 400,
        }
      );
    }

    const validatedData = result.data;

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

    // Only Scheduled meetings can be edited

    if (
      existingMeeting.meetingStatusId === 2
    ) {
      return NextResponse.json(
        {
          message:
            "Completed meetings cannot be edited.",
        },
        {
          status: 400,
        }
      );
    }

    if (
      existingMeeting.meetingStatusId === 3
    ) {
      return NextResponse.json(
        {
          message:
            "Cancelled meetings cannot be edited.",
        },
        {
          status: 400,
        }
      );
    }

    // Validate Meeting Type

    if (
      validatedData.meetingTypeId !==
      undefined
    ) {
      const meetingType =
        await db.query.meetingTypes.findFirst({
          where: eq(
            meetingTypes.meetingTypeId,
            validatedData.meetingTypeId
          ),
        });

      if (!meetingType) {
        return NextResponse.json(
          {
            message:
              "Meeting type not found.",
          },
          {
            status: 404,
          }
        );
      }
    }

    // Validate Room Capacity

    const roomDetails =
      await db.query.room.findFirst({
        where: eq(
          room.room_id,
          existingMeeting.room_id
        ),
      });

    if (!roomDetails) {
      return NextResponse.json(
        {
          message: "Room not found.",
        },
        {
          status: 404,
        }
      );
    }

    const participantCount =
      validatedData.participantCount ??
      existingMeeting.participantCount;

    if (
      roomDetails.room_capacity !== null &&
      participantCount >
        roomDetails.room_capacity
    ) {
      return NextResponse.json(
        {
          message:
            "Room capacity exceeded.",
        },
        {
          status: 400,
        }
      );
    }

    // Validate Attendees

    const attendeeIds =
      validatedData.participantEmployeeIds ??
      [];

    const maximumAttendees =
      participantCount - 1;

    if (
      attendeeIds.length >
      maximumAttendees
    ) {
      return NextResponse.json(
        {
          message: `You can add only ${maximumAttendees} attendee(s). Organizer is counted automatically.`,
        },
        {
          status: 400,
        }
      );
    }

    for (const employeeId of attendeeIds) {
      const attendee =
        await db.query.employee.findFirst({
          where: eq(
            employee.employee_id,
            employeeId
          ),
        });

      if (!attendee) {
        return NextResponse.json(
          {
            message: `Employee ${employeeId} not found.`,
          },
          {
            status: 404,
          }
        );
      }
    }

    // Check if any changes were made

const newTitle =
  validatedData.title ?? existingMeeting.title;

const newParticipantCount =
  validatedData.participantCount ??
  existingMeeting.participantCount;

const newMeetingTypeId =
  validatedData.meetingTypeId ??
  existingMeeting.meetingTypeId;

const existingAttendees = await db
  .select({
    employee_id: meeting_attendees.employee_id,
  })
  .from(meeting_attendees)
  .where(
    eq(meeting_attendees.meeting_id, meetingId)
  );

// Remove organizer from comparison
const oldAttendees = existingAttendees
  .map((a) => a.employee_id)
  .filter(
    (id) =>
      id !== existingMeeting.organizerEmployeeId
  )
  .sort((a, b) => a - b);

const newAttendees = [
  ...(validatedData.participantEmployeeIds ?? []),
].sort((a, b) => a - b);

const noChanges =
  newTitle === existingMeeting.title &&
  newParticipantCount ===
    existingMeeting.participantCount &&
  newMeetingTypeId ===
    existingMeeting.meetingTypeId &&
  JSON.stringify(oldAttendees) ===
    JSON.stringify(newAttendees);

if (noChanges) {
  return NextResponse.json(
    {
      success: false,
      message: "No changes detected.",
    },
    {
      status: 400,
    }
  );
}

    // Update Meeting

    await db
      .update(meeting)
      .set({
        ...(validatedData.title !==
          undefined && {
          title: validatedData.title,
        }),

        ...(validatedData.participantCount !==
          undefined && {
          participantCount:
            validatedData.participantCount,
        }),

        ...(validatedData.meetingTypeId !==
          undefined && {
          meetingTypeId:
            validatedData.meetingTypeId,
        }),

        updated_at: new Date(),
      })
      .where(
        eq(
          meeting.meeting_id,
          meetingId
        )
      );

    // Update Attendees

    if (
      validatedData.participantEmployeeIds !==
      undefined
    ) {
      await db
        .delete(meeting_attendees)
        .where(
          eq(
            meeting_attendees.meeting_id,
            meetingId
          )
        );

      const attendees = [
        existingMeeting.organizerEmployeeId,
        ...validatedData.participantEmployeeIds,
      ];

      const uniqueAttendees = [
        ...new Set(attendees),
      ];

      await db
        .insert(meeting_attendees)
        .values(
          uniqueAttendees.map(
            (employeeId) => ({
              meeting_id: meetingId,
              employee_id: employeeId,
            })
          )
        );
    }

    // Send Updated Meeting Email

    await fetch(
      `${process.env.NEXTAUTH_URL}/api/notifications/email`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          meetingId,
        }),
      }
    );

    return NextResponse.json(
      {
        success: true,
        message:
          "Meeting updated successfully.",
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