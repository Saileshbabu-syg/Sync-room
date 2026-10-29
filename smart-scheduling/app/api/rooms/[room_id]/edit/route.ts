import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db";

import { meeting, room } from "@/db/schema";
import { availabilityMaster } from "@/db/schema";

import { editRoomSchema } from "@/lib/validations/editRoom.validator";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  readJson,
} from "@/lib/api";
import { MEETING_STATUS, ROLE_ADMIN } from "@/lib/constants";
import { nowInAppTimezone } from "@/lib/time";

import { and, eq, gt, or, sql } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      room_id: string;
    }>;
  }
) {
  try {

    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized.",
        },
        {
          status: 401,
        }
      );
    }

    // Admin status is checked against the Employee record on every request,
    // so a demoted admin loses this immediately.
    if (organizer.role !== ROLE_ADMIN) {
      return NextResponse.json(
        {
          success: false,
          message: "Only Admin can edit rooms.",
        },
        {
          status: 403,
        }
      );
    }

    const blocked = guardMutation(req);

    if (blocked) return blocked;

    const roomId = parseIdParam((await params).room_id);

    if (roomId === null) {
      return jsonError(400, "Invalid room id.");
    }

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const result =
      editRoomSchema.safeParse(body.data);

    if (!result.success) {

      return NextResponse.json(
        {
          success: false,
          message:
            result.error.issues[0]
              .message,
        },
        {
          status: 400,
        }
      );

    }

    const validatedData =
      result.data;

    // Check room exists

    const existingRoom =
      await db.query.room.findFirst({
        where: eq(
          room.room_id,
          roomId
        ),
      });

    if (!existingRoom) {

      return NextResponse.json(
        {
          success: false,
          message:
            "Room not found.",
        },
        {
          status: 404,
        }
      );

    }

    // Check availability status

    const status =
      await db.query.availabilityMaster.findFirst(
        {
          where: eq(
            availabilityMaster.availabilityStatusId,
            validatedData.availabilityStatusId
          ),
        }
      );

    if (!status) {

      return NextResponse.json(
        {
          success: false,
          message:
            "Invalid availability status.",
        },
        {
          status: 404,
        }
      );

    }

    // Capacity may not drop below an upcoming meeting that is already booked
    // in this room.
    const now = nowInAppTimezone();

    const [largest] = await db
      .select({
        participants: sql<number>`coalesce(max(${meeting.participantCount}), 0)`,
      })
      .from(meeting)
      .where(
        and(
          eq(meeting.room_id, roomId),
          eq(meeting.meetingStatusId, MEETING_STATUS.SCHEDULED),
          or(
            gt(meeting.meeting_date, now.date),
            and(
              eq(meeting.meeting_date, now.date),
              sql`${meeting.end_time} > ${now.time}::time`
            )
          )
        )
      );

    if (validatedData.room_capacity < Number(largest.participants)) {
      return jsonError(
        409,
        `Capacity cannot be lower than ${largest.participants}: an upcoming meeting in this room has that many participants.`
      );
    }

    // Update room

    await db
      .update(room)
      .set({

        room_name:
          validatedData.room_name,

        room_capacity:
          validatedData.room_capacity,

        roomLocation:
          validatedData.roomLocation,

        facilities:
          validatedData.facilities,

        roomDescription:
          validatedData.roomDescription,

        availabilityStatusId:
          validatedData.availabilityStatusId,

        updated_at:
          new Date(),

      })
      .where(
        eq(
          room.room_id,
          roomId
        )
      );

    return NextResponse.json(
      {
        success: true,
        message:
          "Room updated successfully.",
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
        message:
          "Something went wrong.",
      },
      {
        status: 500,
      }
    );

  }
}
