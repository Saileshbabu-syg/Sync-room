import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { organizers } from "@/db/schema/organizer";
import { room } from "@/db/schema/rooms";
import { availabilityMaster } from "@/db/schema/availabilityMaster";

import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import RoomDetailsCard from "@/components/RoomDetailsCard";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function RoomViewPage({
  params,
}: Props) {

  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

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

  const roomDetails = await db
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
    )
    .where(
      eq(
        room.room_id,
        Number(id)
      )
    );

  if (roomDetails.length === 0) {
    redirect("/rooms");
  }

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <RoomDetailsCard
        room={roomDetails[0]}
        isAdmin={userProfile[0].role === "Admin"}
      />
    </BookingLayout>
  );
}