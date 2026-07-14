import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizers } from "@/db/schema/organizer";
import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import RoomCard from "@/components/RoomCard";

type Props = {
  searchParams: Promise<{
    date: string;
    start: string;
    end: string;
    participants: string;
  }>;
};

export default async function AvailableRoomsPage({
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

  const response = await fetch(
    `${process.env.NEXTAUTH_URL}/api/meetings/suggestions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        meeting_date: params.date,
        start_time: params.start,
        end_time: params.end,
        participant_count: Number(params.participants),
      }),
      cache: "no-store",
    }
  );

  const result = await response.json();

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <div className="space-y-8">

        <div>

          <h1 className="text-3xl font-bold">
            Available Rooms
          </h1>

          <p className="mt-2 text-gray-500">
            Select a room to continue booking.
          </p>

        </div>

        <div className="grid gap-8 lg:grid-cols-2">

          {result.data.map((room: any) => (
            <RoomCard
              key={room.room_id}
              room={room}
              bookingData={params}
            />
          ))}

        </div>

      </div>

    </BookingLayout>
  );
}