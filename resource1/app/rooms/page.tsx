"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

export default function RoomsPage() {
  const router = useRouter();

  const [rooms, setRooms] = useState<any[]>([]);

  useEffect(() => {
    async function loadRooms() {
      const response = await fetch("/api/rooms");

      const data = await response.json();

      setRooms(data);
    }

    loadRooms();
  }, []);

  return (
    <div className="p-6">

      <h1 className="text-3xl font-bold mb-6">
        All Rooms
      </h1>

      {rooms.length === 0 ? (
        <p>No rooms found.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">

          {rooms.map((room) => (
            <div
              key={room.roomId}
              className="border rounded-lg p-4 shadow"
            >
              <img
                src="https://placehold.co/400x200?text=Room"
                alt="Room"
                className="w-full rounded mb-4"
              />

              <h2 className="text-xl font-bold">
                {room.roomName}
              </h2>

              <p className="mt-2">
                Capacity: {room.roomCapacity}
              </p>

              <p>
                Facilities: {room.facilities}
              </p>

              <Button
                className="mt-4 w-full"
                onClick={() =>
                  router.push(`/rooms/${room.roomId}`)
                }
              >
                View Details
              </Button>
            </div>
          ))}

        </div>
      )}

    </div>
  );
}