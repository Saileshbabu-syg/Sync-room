"use client";

import Image from "next/image";
import Link from "next/link";

import {
  Users,
  MapPin,
  ClipboardList,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import RoomArchiveButton from "@/components/RoomArchiveButton";

type Room = {
  roomId: number;
  roomName: string;
  capacity: number;
  location: string | null;
  facilities: string |null;
  description: string | null;
  status: string | null;
  imageUrl: string | null;
  // Archived rooms are listed (for room managers) but never bookable.
  archived?: boolean;
  // Whether the room can be booked right now (active and available).
  bookable?: boolean;
};

type Props = {
  room: Room;
  isAdmin?: boolean;
};

export default function RoomListCard({
  room,
  isAdmin = false,
}: Props) {
  return (
    <div className="overflow-hidden rounded-3xl bg-white shadow-md transition hover:shadow-xl">

      <Image
  src={
    room.imageUrl ??
    "/images/rooms/default-room.jpg"
  }
  alt={room.roomName}
  width={600}
  height={350}
  className="h-56 w-full object-cover"
/>

      <div className="space-y-5 p-6">

        <div className="flex items-center justify-between">

          <h2 className="text-2xl font-bold">
            {room.roomName}
          </h2>

          <span
  className={`rounded-full px-3 py-1 text-sm font-medium ${
    room.archived
      ? "bg-gray-200 text-gray-700"
      : room.status?.toUpperCase() === "AVAILABLE"
      ? "bg-green-100 text-green-700"
      : room.status?.toUpperCase() === "MAINTENANCE"
      ? "bg-yellow-100 text-yellow-700"
      : "bg-red-100 text-red-700"
  }`}
>
  {room.archived ? "ARCHIVED" : room.status}
</span>
        </div>

        <div className="flex items-center gap-3 text-gray-600">

          <Users className="h-5 w-5 text-blue-600" />

          Capacity : {room.capacity}

        </div>

        <div className="flex items-center gap-3 text-gray-600">

          <MapPin className="h-5 w-5 text-blue-600" />

          {room.location || "Not Available"}

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
            {room.description}
          </p>

        </div>

        <div className="flex flex-wrap gap-3">

          {isAdmin && !room.archived && (
            <Button asChild variant="secondary">
              <Link href={`/rooms/${room.roomId}/edit`}>Edit Room</Link>
            </Button>
          )}

          {isAdmin && (
            <RoomArchiveButton
              roomId={room.roomId}
              roomName={room.roomName}
              archived={room.archived === true}
            />
          )}

          {room.bookable ? (
            <Button asChild className="flex-1">
              <Link href={`/booking/details?roomId=${room.roomId}`}>
                Book Room
              </Link>
            </Button>
          ) : (
            <Button className="flex-1" disabled>
              Book Room
            </Button>
          )}

        </div>

      </div>

    </div>
  );
}