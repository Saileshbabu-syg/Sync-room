import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import RoomListCard from "@/components/RoomListCard";
import { Button } from "@/components/ui/button";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { AVAILABILITY_STATUS } from "@/lib/constants";
import { listRoomsFor } from "@/lib/services/room.service";

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

  // Room managers see every room (and the archived ones, separately); everyone
  // else the active rooms their group may book (room.service).
  const { rooms, canManage } = await listRoomsFor(
    { employeeId: currentUser.employeeId, role: currentUser.role },
    { includeArchived: true }
  );

  const toCard = (r: (typeof rooms)[number]) => ({
    roomId: r.room_id,
    roomName: r.room_name,
    capacity: r.room_capacity,
    location: r.roomLocation,
    facilities: r.facilities,
    description: r.roomDescription,
    imageUrl: r.imageUrl,
    status: r.statusCode,
    archived: r.archived_at !== null,
    // Same rule the booking service enforces: decided by the status id, never
    // by the (differently cased) status text.
    bookable:
      r.archived_at === null &&
      r.availabilityStatusId === AVAILABILITY_STATUS.AVAILABLE,
  });

  const active = rooms.filter((r) => r.archived_at === null).map(toCard);
  const archived = rooms.filter((r) => r.archived_at !== null).map(toCard);

  return (
    <>
      <div className="space-y-8">

        <div className="flex flex-wrap items-start justify-between gap-4">

          <div>
            <h1 className="text-3xl font-bold">
              Rooms
            </h1>

            <p className="mt-2 text-gray-500">
              {canManage
                ? "Manage the meeting rooms."
                : "Browse the meeting rooms you can book."}
            </p>
          </div>

          {canManage && (
            <Button asChild>
              <Link href="/rooms/new">Add Room</Link>
            </Button>
          )}

        </div>

        {active.length === 0 ? (
          <p className="rounded-xl border bg-white p-8 text-center text-gray-500">
            No rooms to show.
          </p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {active.map((room) => (
              <RoomListCard key={room.roomId} room={room} isAdmin={canManage} />
            ))}
          </div>
        )}

        {canManage && archived.length > 0 && (
          <section className="space-y-4" aria-labelledby="archived-rooms">
            <h2 id="archived-rooms" className="text-xl font-semibold text-gray-700">
              Archived rooms
            </h2>
            <p className="text-sm text-gray-500">
              Not bookable; kept for the meetings that were held in them.
            </p>
            <div className="grid gap-6 lg:grid-cols-2">
              {archived.map((room) => (
                <RoomListCard key={room.roomId} room={room} isAdmin={canManage} />
              ))}
            </div>
          </section>
        )}

      </div>
    </>
  );
}
