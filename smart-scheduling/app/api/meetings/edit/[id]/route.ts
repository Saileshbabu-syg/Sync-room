import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { meeting } from "@/db/schema/meeting";
import { meetingTypes } from "@/db/schema/meetingTypes";
import { room } from "@/db/schema/rooms";
import { employee } from "@/db/schema/employee";
import { meeting_attendees } from "@/db/schema/meeting_attendees";
import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";
import { eq } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const body = await req.json();

    const result = editMeetingSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          message: "Validation failed",
          errors: result.error.issues,
        },
        { status: 400 }
      );
    }

    const validatedData = result.data;

    // 1. Check meeting exists
    const existingMeeting = await db.query.meeting.findFirst({
      where: eq(meeting.meeting_id, Number(id)),
    });

    if (!existingMeeting) {
      return NextResponse.json(
        { message: "Meeting not found" },
        { status: 404 }
      );
    }

    // 2. Validate meeting type (if provided)
    if (validatedData.meetingTypeId !== undefined) {
      const typeExists = await db.query.meetingTypes.findFirst({
        where: eq(
          meetingTypes.meetingTypeId,
          validatedData.meetingTypeId
        ),
      });

      if (!typeExists) {
        return NextResponse.json(
          { message: "Meeting type not found" },
          { status: 404 }
        );
      }
    }

    // 3. Validate participant count & room capacity
    const shouldValidateCapacity =
      validatedData.participantCount !== undefined ||
      validatedData.participantEmployeeIds !== undefined;

    if (shouldValidateCapacity) {
      const roomDetails = await db.query.room.findFirst({
        where: eq(room.room_id, existingMeeting.room_id),
      });

      if (!roomDetails) {
        return NextResponse.json(
          { message: "Room not found" },
          { status: 404 }
        );
      }

      const finalCount =
        validatedData.participantCount ??
        existingMeeting.participantCount;

      if (
        roomDetails.room_capacity !== null &&
        finalCount > roomDetails.room_capacity
      ) {
        return NextResponse.json(
          { message: "Room capacity exceeded" },
          { status: 400 }
        );
      }
    }

    // 4. Validate participants (if provided)
    if (validatedData.participantEmployeeIds !== undefined) {
      for (const empId of validatedData.participantEmployeeIds) {
        const empExists = await db.query.employee.findFirst({
          where: eq(employee.employee_id, empId),
        });

        if (!empExists) {
          return NextResponse.json(
            {
              message: `Employee ${empId} not found`,
            },
            { status: 404 }
          );
        }
      }

      const finalCount =
        validatedData.participantCount ??
        existingMeeting.participantCount;

      if (
        validatedData.participantEmployeeIds.length > finalCount
      ) {
        return NextResponse.json(
          {
            message:
              "Participant IDs exceed participant count",
          },
          { status: 400 }
        );
      }
    }

    // 5. Update meeting (partial update)
    await db
      .update(meeting)
      .set({
        ...(validatedData.title !== undefined && {
          title: validatedData.title,
        }),
        ...(validatedData.participantCount !== undefined && {
          participantCount: validatedData.participantCount,
        }),
        ...(validatedData.meetingTypeId !== undefined && {
          meetingTypeId: validatedData.meetingTypeId,
        }),
      })
      .where(eq(meeting.meeting_id, Number(id)));

    // 6. Update attendees (if provided)
    if (validatedData.participantEmployeeIds !== undefined) {
      await db
        .delete(meeting_attendees)
        .where(eq(meeting_attendees.meeting_id, Number(id)));

      await db.insert(meeting_attendees).values(
        validatedData.participantEmployeeIds.map((empId) => ({
          meeting_id: Number(id),
          employee_id: empId,
        }))
      );
    }

    return NextResponse.json(
      {
        message: "Meeting updated successfully",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}