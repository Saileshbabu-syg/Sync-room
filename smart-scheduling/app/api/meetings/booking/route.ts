import { NextRequest, NextResponse } from "next/server";
import { createMeetingSchema } from "@/lib/validations/meeting.validator";
import { db } from "@/db";

import { employee } from "@/db/schema/employee";
import { room } from "@/db/schema/rooms";
import { meeting } from "@/db/schema/meeting";
import { meetingTypes } from "@/db/schema/meetingTypes";
import { meetingStatuses } from "@/db/schema/meetingStatuses";
import { meeting_attendees } from "@/db/schema/meeting_attendees";
import { and, eq, lt, gt } from "drizzle-orm";

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
    validatedData.participant_count
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
  where: eq(employee.employee_id, validatedData.organizer_employee_id),
});

if (!employeeExists) {
  return NextResponse.json(
    { message: "Employee not found" },
    { status: 404 }
  );
}

const roomDetails = await db.query.room.findFirst({
  where: eq(room.room_id, validatedData.room_id),
});

if (!roomDetails) {
  return NextResponse.json(
    { message: "Room not found" },
    { status: 404 }
  );
}

if (
  roomDetails.room_capacity !== null &&
  validatedData.participant_count > roomDetails.room_capacity
) {
  return NextResponse.json(
    { message: "Room capacity exceeded" },
    { status: 400 }
  );
}

if (validatedData.start_time >= validatedData.end_time) {
  return NextResponse.json(
    { message: "End time must be after start time" },
    { status: 400 }
  );
}

const existingMeeting = await db.query.meeting.findFirst({
  where: and(
    eq(meeting.room_id, validatedData.room_id),
    eq(meeting.meeting_date, validatedData.meeting_date),
    lt(meeting.start_time, validatedData.end_time),
    gt(meeting.end_time, validatedData.start_time)
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
    where: eq(employee.employee_id, employeeId),
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
  .insert(meeting)
  .values({
    title: validatedData.title,
    meeting_date: validatedData.meeting_date,
    organizerEmployeeId: validatedData.organizer_employee_id,
    room_id: validatedData.room_id,
    participantCount: validatedData.participant_count,
    meetingTypeId: validatedData.meeting_type_id,
    meetingStatusId: validatedData.meeting_status_id,
    start_time: validatedData.start_time,
    end_time: validatedData.end_time,
  })
  .returning();


  const meetingId = insertedMeeting[0].meeting_id;


if (attendeeIds.length > 0) {
  await db.insert(meeting_attendees).values(
    attendeeIds.map((employee_id) => ({
      meeting_id: meetingId,
      employee_id: employee_id,
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
  console.error(error);

  return NextResponse.json(
    {
      message: "Something went wrong",
      error,
    },
    { status: 500 }
  );
}
}

