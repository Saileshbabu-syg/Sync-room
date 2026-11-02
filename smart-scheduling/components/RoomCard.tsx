"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  Users,
  MapPin,
  ClipboardList,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type Room = {
  room_id: number;
  room_name: string;
  room_capacity: number;
  roomLocation: string | null;
  facilities: string | null;
  roomDescription: string | null;
  imageUrl: string | null;
};

type Props = {
  room: Room;
  bookingData: {
    date: string;
    start: string;
    end: string;
    participants: string;
  };
  // The room is booked by a lower-priority meeting; a higher-priority meeting
  // type can take it over.
  priorityClaim?: boolean;
  // The room is booked for this time. It can still be chosen: at confirmation
  // the user sees the existing booking and can ask its organizer for the room.
  occupied?: boolean;
};

export default function RoomCard({
  room,
  bookingData,
  priorityClaim = false,
  occupied = false,
}: Props) {
  const router = useRouter();

  const handleSelectRoom = () => {
  if (
    Number(bookingData.participants) >
    room.room_capacity
  ) {
    toast.warning(
      "Participant count exceeds room capacity."
    );
    return;
  }

  const query = new URLSearchParams({
    roomId: room.room_id.toString(),
    roomName: room.room_name,
    date: bookingData.date,
    start: bookingData.start,
    end: bookingData.end,
    participants: bookingData.participants,
  });

  router.push(
    `/booking/details?${query.toString()}`
  );
};

console.log(room);

  return (
    <div className="overflow-hidden rounded-3xl bg-white shadow-md transition hover:shadow-xl">

      <Image
  src={
    room.imageUrl ??
    "/images/rooms/default-room.jpg"
  }
  alt={room.room_name}
  width={600}
  height={350}
  className="h-56 w-full object-cover"
/>

      <div className="space-y-5 p-6">

        <h2 className="text-2xl font-bold">
          {room.room_name}
        </h2>

        {occupied && (
          <p
            className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
            data-testid="occupied-room-note"
          >
            <span className="font-semibold">Occupied.</span> This room is
            already booked for this time. You can still select it; when you
            confirm, you will see the existing booking and can request the room
            from its organizer.
          </p>
        )}

        {priorityClaim && (
          <p
            className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800"
            data-testid="priority-claim-note"
          >
            Booked by a lower-priority meeting. Choose a higher-priority
            meeting type (for example Interview) to take this room; the
            current organizer is notified and moved to another room or asked
            to rebook.
          </p>
        )}

        <div className="flex items-center gap-3 text-gray-600">

          <Users className="h-5 w-5 text-blue-600" />

          Capacity : {room.room_capacity}

        </div>

        <div className="flex items-center gap-3 text-gray-600">

          <MapPin className="h-5 w-5 text-blue-600" />

          {room.roomLocation || "Not Available"}

        </div>

        <div className="flex items-start gap-3 text-gray-600">

          <ClipboardList className="mt-1 h-5 w-5 text-blue-600" />

          <div>

            <p className="font-semibold">
              Facilities
            </p>

            <p>
              {room.facilities || "Not Available"}
            </p>

          </div>

        </div>

        <div>

          <p className="text-gray-600">
            {room.roomDescription}
          </p>

        </div>

        <Button
          className="w-full"
          onClick={handleSelectRoom}
        >
          Select Room
        </Button>

      </div>

    </div>
  );
}