import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizers } from "@/db/schema/organizer";
import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import BookingSummaryCard from "@/components/BookingSummaryCard";
import MeetingDetailsForm from "@/components/MeetingDetailsForm";

import { room } from "@/db/schema/rooms";
import BackButton from "@/components/BackButton";

type Props = {
  searchParams: Promise<{
    roomId: string;
    roomName: string;
    date: string;
    start: string;
    end: string;
    participants: string;
  }>;
};

export default async function BookingDetailsPage({
  searchParams,
}: Props) {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;

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
    .where(eq(organizers.email, session.user!.email!));

  const roomData = await db
    .select()
    .from(room)
    .where(eq(room.room_id, Number(params.roomId)));

  if (roomData.length === 0) {
    return <h1>Room Not Found</h1>;
  }

  return (
   <BookingLayout
  session={session}
  userProfile={userProfile[0]}
>

  <div className="mb-6 flex justify-end">

    <BackButton />

  </div>

  <div className="grid gap-8 lg:grid-cols-2">

    <BookingSummaryCard
      room={roomData[0]}
    />

    <MeetingDetailsForm
      roomId={roomData[0].room_id}
      organizerEmployeeId={
        userProfile[0].employeeId!
      }
      meetingDate={params.date}
      startTime={params.start}
      endTime={params.end}
      participantCount={Number(
        params.participants
      )}
    />

  </div>

</BookingLayout>
  );

}