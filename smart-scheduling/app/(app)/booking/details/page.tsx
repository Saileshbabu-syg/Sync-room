import { auth } from "@/auth";
import { parseIdParam } from "@/lib/api";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { notFound, redirect } from "next/navigation";

import { db } from "@/db";
import { eq } from "drizzle-orm";

import BookingSummaryCard from "@/components/BookingSummaryCard";
import MeetingDetailsForm from "@/components/MeetingDetailsForm";
import { canUseRoom, getBookingPolicy } from "@/lib/services/booking-policy.service";

import { room } from "@/db/schema";

type Props = {
  searchParams: Promise<{
    roomId: string;
    roomName?: string;
    date?: string;
    start?: string;
    end?: string;
    participants?: string;
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
    notFound();
  }

  if (roomData[0].archived_at !== null) {
    return (
      <div className="rounded-xl border bg-white p-10 text-center shadow">
        <h1 className="text-xl font-semibold">Room archived</h1>
        <p className="mt-2 text-gray-500">
          {roomData[0].room_name} has been archived and can no longer be booked. Please choose another room.
        </p>
      </div>
    );
  }

  if (!canUseRoom(await getBookingPolicy(userProfile[0].employeeId), roomData[0].room_id)) {
    return (
      <div className="rounded-xl border bg-white p-10 text-center shadow">
        <h1 className="text-xl font-semibold">Room not available to your group</h1>
        <p className="mt-2 text-gray-500">
          Your group is not allowed to book {roomData[0].room_name}. Please choose another room.
        </p>
      </div>
    );
  }

  return (
   <>

  <div className="grid gap-8 lg:grid-cols-2">

    <BookingSummaryCard
      room={roomData[0]}
    />

    <MeetingDetailsForm
      roomId={roomData[0].room_id}
      organizerEmployeeId={
        userProfile[0].employeeId!
      }
      roomCapacity={roomData[0].room_capacity}
      meetingDate={params.date ?? ""}
      startTime={params.start ?? ""}
      endTime={params.end ?? ""}
    />

  </div>

</>
  );

}