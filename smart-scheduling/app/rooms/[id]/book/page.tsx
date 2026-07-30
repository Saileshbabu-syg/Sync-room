import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { organizers } from "@/db/schema/organizer";
import { room } from "@/db/schema/rooms";

import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import RoomBookingForm from "@/components/RoomBookingForm";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function BookRoomPage({
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

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <RoomBookingForm
        room={roomDetails[0]}
        organizerEmployeeId={
          userProfile[0].employeeId
        }
      />
    </BookingLayout>
  );
}