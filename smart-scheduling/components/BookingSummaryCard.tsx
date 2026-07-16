import Image from "next/image";

import {
  Users,
  MapPin,
  ClipboardList,
} from "lucide-react";

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
};

export default function BookingSummaryCard({
  room,
}: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-white shadow">

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

        <h2 className="text-3xl font-bold">
          {room.room_name}
        </h2>

        <div className="flex items-center gap-3">

          <Users className="text-blue-600" />

          Capacity : {room.room_capacity}

        </div>

        <div className="flex items-center gap-3">

          <MapPin className="text-blue-600" />

          {room.roomLocation || "Not Available"}

        </div>

        <div className="flex items-start gap-3">

          <ClipboardList className="mt-1 text-blue-600" />

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

      </div>

    </div>
  );
}