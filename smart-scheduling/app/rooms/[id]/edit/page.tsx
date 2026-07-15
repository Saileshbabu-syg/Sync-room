import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { organizers } from "@/db/schema/organizer";
import { room } from "@/db/schema/rooms";
import { availabilityMaster } from "@/db/schema/availabilityMaster";

import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import EditRoomForm from "@/components/EditRoomForm";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function EditRoomPage({
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

    if (
  userProfile.length === 0 ||
  userProfile[0].role !== "Admin"
) {
  redirect("/rooms");
}

  const roomDetails = await db
    .select()
    .from(room)
    .where(
      eq(
        room.room_id,
        Number(id)
      )
    );

  if (roomDetails.length === 0) {
    redirect("/rooms");
  }

  const availabilityStatuses = (
  await db
    .select({
      availabilityStatusId:
        availabilityMaster.availabilityStatusId,

      availabilityStatusName:
        availabilityMaster.availabilityStatusCode,
    })
    .from(availabilityMaster)
).map((status) => ({
  availabilityStatusId:
    status.availabilityStatusId,

  availabilityStatusName:
    status.availabilityStatusName ?? "",
}));

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <EditRoomForm
        room={roomDetails[0]}
        availabilityStatuses={
          availabilityStatuses
        }
      />
    </BookingLayout>
  );
}