
import { NextRequest, NextResponse } from "next/server";
import { createMeetingSchema } from "@/validators/meeting.validator";
import { db } from "@/db";

import { employee } from "@/db/schema/employee";
import { rooms } from "@/db/schema/rooms";
import { meetings } from "@/db/schema/meetings";
import { meetingTypes } from "@/db/schema/meetingTypes";
import { meetingStatuses } from "@/db/schema/meetingStatuses";
import { meetingAttendees } from "@/db/schema/meetingAttendees";
import { and, eq, lt, gt } from "drizzle-orm";


export async function GET() {
  return NextResponse.json({
    message: "Meeting API Working",
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

   const result = createMeetingSchema.safeParse(body);

if (!result.success) {
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



if (
  validatedData.participantEmployeeIds &&
  validatedData.participantEmployeeIds.length >
    validatedData.participantCount
) {
  return NextResponse.json(
    {
      message:
        "Participant employee count cannot exceed participant count",
    },
    { status: 400 }
  );
}

    const employeeExists = await db.query.employee.findFirst({
  where: eq(employee.employeeId, validatedData.organizerEmployeeId),
});

if (!employeeExists) {
  return NextResponse.json(
    { message: "Employee not found" },
    { status: 404 }
  );
}

const roomDetails = await db.query.rooms.findFirst({
  where: eq(rooms.roomId, validatedData.roomId),
});

if (!roomDetails) {
  return NextResponse.json(
    { message: "Room not found" },
    { status: 404 }
  );
}

if (
  roomDetails.roomCapacity !== null &&
  validatedData.participantCount > roomDetails.roomCapacity
) {
  return NextResponse.json(
    { message: "Room capacity exceeded" },
    { status: 400 }
  );
}

if (validatedData.startTime >= validatedData.endTime) {
  return NextResponse.json(
    { message: "End time must be after start time" },
    { status: 400 }
  );
}

const existingMeeting = await db.query.meetings.findFirst({
  where: and(
    eq(meetings.roomId, validatedData.roomId),
    eq(meetings.meetingDate, validatedData.meetingDate),
    lt(meetings.startTime, validatedData.endTime),
    gt(meetings.endTime, validatedData.startTime)
  ),
});

if (existingMeeting) {
  return NextResponse.json(
    {
      message: "Room is already booked for the selected time slot",
    },
    {
      status: 409,
    }
  );
}


const attendeeIds =
  validatedData.participantEmployeeIds ?? [];

for (const employeeId of attendeeIds) {
  const attendee = await db.query.employee.findFirst({
    where: eq(employee.employeeId, employeeId),
  });

  if (!attendee) {
    return NextResponse.json(
      {
        message: `Employee ${employeeId} not found`,
      },
      { status: 404 }
    );
  }
}


const insertedMeeting = await db
  .insert(meetings)
  .values({
    title: validatedData.title,
    meetingDate: validatedData.meetingDate,
    organizerEmployeeId: validatedData.organizerEmployeeId,
    roomId: validatedData.roomId,
    participantCount: validatedData.participantCount,
    meetingTypeId: validatedData.meetingTypeId,
    meetingStatusId: validatedData.meetingStatusId,
    startTime: validatedData.startTime,
    endTime: validatedData.endTime,
  })
  .returning();


  const meetingId = insertedMeeting[0].meetingId;

  // const attendeeIds = validatedData.participantEmployeeIds ?? [];

if (attendeeIds.length > 0) {
  await db.insert(meetingAttendees).values(
    attendeeIds.map((employeeId: number) => ({
      meetingId: meetingId,
      employeeId: employeeId,
    }))
  );
}
    return NextResponse.json({
      message: "Validation successful",
      data: validatedData,
    },
    {status: 201,}
    );
  } catch (error) {
    return NextResponse.json(
      { message: "Something went wrong" },
      { status: 500 }
    );
  }
}