import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { meetings } from "@/db/schema/meetings";
import { meetingTypes } from "@/db/schema/meetingTypes";
import { room } from "@/db/schema/room";
import { employee } from "@/db/schema/employee";
import { meetingAttendees } from "@/db/schema/meetingAttendees";
import { editMeetingSchema } from "@/validators/editMeeting.validator";
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
    const existingMeeting = await db.query.meetings.findFirst({
      where: eq(meetings.meetingId, Number(id)),
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
        where: eq(room.roomId, existingMeeting.roomId),
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
        roomDetails.roomCapacity !== null &&
        finalCount > roomDetails.roomCapacity
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
          where: eq(employee.employeeId, empId),
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
      .update(meetings)
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
      .where(eq(meetings.meetingId, Number(id)));

    // 6. Update attendees (if provided)
    if (validatedData.participantEmployeeIds !== undefined) {
      await db
        .delete(meetingAttendees)
        .where(eq(meetingAttendees.meetingId, Number(id)));

      await db.insert(meetingAttendees).values(
        validatedData.participantEmployeeIds.map((empId) => ({
          meetingId: Number(id),
          employeeId: empId,
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