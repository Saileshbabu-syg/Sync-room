import { Suspense } from "react";

import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { getClaimableRooms } from "@/lib/services/priority.service";
import { getOccupiedRooms } from "@/lib/services/room-request.service";
import { getAvailableRooms } from "@/lib/services/room-suggestion.service";
import { availableRoomsQuerySchema } from "@/lib/validations/suggestions.validator";

import RoomCard from "@/components/RoomCard";

type SearchQuery = {
  date: string;
  start: string;
  end: string;
  participants: number;
};

// Loaded inside a Suspense boundary so the shell (and its loading state) can
// stream while rooms are looked up. Authentication and query validation happen
// BEFORE the boundary, so anonymous / malformed requests still get a real
// 307 redirect instead of a 200 loading shell.
async function RoomResults({
  query,
  role,
}: {
  query: SearchQuery;
  role: string;
}) {
  const [rooms, claimableRooms] = await Promise.all([
    getAvailableRooms(
      query.date,
      query.start,
      query.end,
      query.participants
    ),
    // Rooms held only by lower-priority meetings than this role can book.
    getClaimableRooms(
      role,
      query.date,
      query.start,
      query.end,
      query.participants
    ),
  ]);

  // Everything else that is taken: still selectable, and a request can be
  // made at confirmation.
  const occupiedRooms = await getOccupiedRooms(
    query.date,
    query.start,
    query.end,
    query.participants,
    [...rooms, ...claimableRooms].map((r) => r.room_id)
  );

  if (
    rooms.length === 0 &&
    claimableRooms.length === 0 &&
    occupiedRooms.length === 0
  ) {
    return (
      <div
        className="rounded-xl border bg-white p-10 text-center shadow"
        data-testid="no-rooms-available"
      >
        <h2 className="text-xl font-semibold">No rooms available</h2>

        <p className="mt-2 text-gray-500">
          No room is in service and large enough for the selected number of
          participants. Try fewer participants.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {rooms.map((room) => (
        <RoomCard
          key={room.room_id}
          room={room}
          bookingData={{
            date: query.date,
            start: query.start,
            end: query.end,
            participants: String(query.participants),
          }}
        />
      ))}
      {claimableRooms.map((room) => (
        <RoomCard
          key={room.room_id}
          room={room}
          priorityClaim
          bookingData={{
            date: query.date,
            start: query.start,
            end: query.end,
            participants: String(query.participants),
          }}
        />
      ))}
      {occupiedRooms.map((room) => (
        <RoomCard
          key={room.room_id}
          room={room}
          occupied
          bookingData={{
            date: query.date,
            start: query.start,
            end: query.end,
            participants: String(query.participants),
          }}
        />
      ))}
    </div>
  );
}

function RoomsSkeleton() {
  return (
    <div
      className="grid gap-8 lg:grid-cols-2"
      role="status"
      aria-live="polite"
      data-testid="rooms-loading"
    >
      <span className="sr-only">Checking which rooms are free...</span>
      <div className="h-48 animate-pulse rounded-xl bg-gray-200" />
      <div className="h-48 animate-pulse rounded-xl bg-gray-200" />
    </div>
  );
}

type Props = {
  searchParams: Promise<{
    date?: string;
    start?: string;
    end?: string;
    participants?: string;
  }>;
};

export default async function AvailableRoomsPage({
  searchParams,
}: Props) {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee: treat as signed out.
  if (!currentUser) {
    redirect("/login");
  }

  const params = await searchParams;

  // The page used to POST to its own /api/meetings/suggestions without
  // forwarding the session cookie, so the API answered 401 and the page
  // crashed on `result.data.map`. It now validates the query and calls the
  // service directly — the session was already verified above, and nothing
  // is turned into a fake "success".
  const query = availableRoomsQuerySchema.safeParse(params);

  if (!query.success) {
    redirect("/booking");
  }

  return (
    <>
      <div className="space-y-8">

        <div className="flex items-start justify-between">

  <div>

    <h1 className="text-3xl font-bold">
      Available Rooms
    </h1>

    <p className="mt-2 text-gray-500">
      Select a room to continue booking.
    </p>

  </div>

</div>

        <Suspense fallback={<RoomsSkeleton />}>
          <RoomResults query={query.data} role={currentUser.role} />
        </Suspense>

      </div>

    </>
  );
}
