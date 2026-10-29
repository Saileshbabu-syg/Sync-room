import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { room } from "@/db/schema";
import { availabilityMaster } from "@/db/schema";

import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import RoomListCard from "@/components/RoomListCard";

export default async function RoomsPage() {

  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

  const rooms = await db
    .select({
      roomId: room.room_id,
      roomName: room.room_name,
      capacity: room.room_capacity,
      location: room.roomLocation,
      facilities: room.facilities,
      description: room.roomDescription,
      imageUrl: room.imageUrl,
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