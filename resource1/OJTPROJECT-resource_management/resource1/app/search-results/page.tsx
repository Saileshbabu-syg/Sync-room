"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function SearchResultsPage() {
  const params = useSearchParams();
  const router = useRouter();

  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedFacility, setSelectedFacility] = useState("");

  const date = params.get("date");
  const start = params.get("start");
  const end = params.get("end");
  const capacity = params.get("capacity");

  // Load rooms from API
  async function loadRooms(facility = "") {
    let url =
      `/api/search-rooms?date=${date}` +
      `&start=${start}` +
      `&end=${end}` +
      `&capacity=${capacity}`;

    if (facility) {
      url += `&facility=${facility}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    setRooms(data);
  }

  useEffect(() => {
    loadRooms();
  }, [date, start, end, capacity]);

  return (
    <div className="flex min-h-screen">
      {/* LEFT FILTER */}
      <div className="w-64 border-r p-5">
        <h2 className="text-xl font-bold mb-4">
          Filters
        </h2>

        <Button
          variant="outline"
          className="w-full mb-2"
          onClick={() => {
            setSelectedFacility("PROJECTOR");
            loadRooms("PROJECTOR");
          }}
        >
          Projector
        </Button>

        <Button
          variant="outline"
          className="w-full mb-2"
          onClick={() => {
            setSelectedFacility("TV");
            loadRooms("TV");
          }}
        >
          TV
        </Button>

        <Button
          variant="outline"
          className="w-full mb-2"
          onClick={() => {
            setSelectedFacility("AC");
            loadRooms("AC");
          }}
        >
          AC
        </Button>

        <Button
          variant="secondary"
          className="w-full"
          onClick={() => {
            setSelectedFacility("");
            loadRooms();
          }}
        >
          Reset Filters
        </Button>

        {selectedFacility && (
          <p className="mt-4 text-sm text-gray-500">
            Selected: {selectedFacility}
          </p>
        )}
      </div>

      {/* RIGHT ROOMS */}
      <div className="flex-1 p-6">
        <h1 className="text-2xl font-bold mb-2">
          Available Rooms
        </h1>

        <p className="text-gray-500 mb-6">
          Date: {date} | Time: {start} - {end} | Capacity: {capacity}
        </p>

        {rooms.length === 0 ? (
          <div className="text-center mt-10">
            <p className="text-lg">
              No rooms available.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {rooms.map((room) => (
              <div
                key={room.roomId}
                className="border rounded-lg p-4 shadow hover:shadow-lg transition"
              >
                <img
                  src="https://placehold.co/400x200?text=Room"
                  alt="Room"
                  className="rounded mb-3 w-full"
                />

                <h2 className="font-bold text-lg">
                  {room.roomName}
                </h2>

                <p className="mt-2">
                  Capacity: {room.roomCapacity}
                </p>

                <p className="mt-1">
                  Facilities: {room.facilities}
                </p>

                <Button
  className="mt-4 w-full"
  onClick={() =>
    router.push(
      `/rooms/${room.roomId}/confirm?roomName=${encodeURIComponent(
        room.roomName
      )}&date=${date}&start=${start}&end=${end}`
    )
  }
>
  Book Room
</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}