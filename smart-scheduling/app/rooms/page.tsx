import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizers } from "@/db/schema/organizer";
import { room } from "@/db/schema/rooms";
import { availabilityMaster } from "@/db/schema/availabilityMaster";

import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import RoomListCard from "@/components/RoomListCard";

export default async function RoomsPage() {

  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const userProfile = await db
    .select({
      organizerId: organizers.organizerId,
      employeeId: organizers.employeeId,
      name: organizers.name,
      email: organizers.email,
      role: organizers.role,
      imageUrl: organizers.imageUrl,
    })
    .from(organizers)
    .where(
      eq(
        organizers.email,
        session.user!.email!
      )
    );

  const rooms = await db
    .select({
      roomId: room.room_id,
      roomName: room.room_name,
      capacity: room.room_capacity,
      location: room.roomLocation,
      facilities: room.facilities,
      description: room.roomDescription,
      status:
        availabilityMaster.availabilityStatusCode,
    })
    .from(room)
    .leftJoin(
      availabilityMaster,
      eq(
        room.availabilityStatusId,
        availabilityMaster.availabilityStatusId
      )
    );

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <div className="space-y-8">

        <div>

          <h1 className="text-3xl font-bold">
            Rooms
          </h1>

          <p className="mt-2 text-gray-500">
            Browse all available meeting rooms.
          </p>

        </div>

        <div className="grid gap-6 lg:grid-cols-2">

          {rooms.map((room) => (

            <RoomListCard
              key={room.roomId}
              room={room}
            />

          ))}

        </div>

      </div>
    </BookingLayout>
  );
}