import { auth } from "@/auth";
import { parseIdParam } from "@/lib/api";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import BookingSummaryCard from "@/components/BookingSummaryCard";
import MeetingDetailsForm from "@/components/MeetingDetailsForm";

import { room } from "@/db/schema";
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

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

  const roomData = await db
    .select()
    .from(room)
    .where(eq(room.room_id, parseIdParam(params.roomId) ?? -1));

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