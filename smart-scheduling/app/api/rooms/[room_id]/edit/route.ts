import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/auth";
import { organizers } from "@/db/schema/organizer";

import { db } from "@/db";

import { room } from "@/db/schema/rooms";
import { availabilityMaster } from "@/db/schema/availabilityMaster";

import { editRoomSchema } from "@/lib/validations/editRoom.validator";

import { eq } from "drizzle-orm";

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

    const session = await auth();

if (!session?.user?.email) {
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

const organizer = await db.query.organizers.findFirst({
  where: eq(
    organizers.email,
    session.user.email
  ),
});

if (
  !organizer ||
  organizer.role !== "Admin"
) {
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

    const { room_id } =
      await params;

    const roomId =
      Number(room_id);

    if (isNaN(roomId)) {

      return NextResponse.json(
        {
          success: false,
          message:
            "Invalid room id.",
        },
        {
          status: 400,
        }
      );

    }

    const body =
      await req.json();

    const result =
      editRoomSchema.safeParse(body);

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