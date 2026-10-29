import { auth } from "@/auth";
import { parseIdParam } from "@/lib/api";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import { db } from "@/db";

import { room } from "@/db/schema";

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

  const roomId = parseIdParam(id);

  if (roomId === null) {
    redirect("/rooms");
  }

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

  const roomDetails = await db
    .select()
    .from(room)
    .where(
      eq(
        room.room_id,
        roomId
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