"use client";

import Link from "next/link";

import {
  Building2,
  Users,
  MapPin,
  ClipboardList,
  BadgeCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type Room = {
  roomId: number;
  roomName: string;
  capacity: number;
  location: string | null;
  facilities: string | null;
  description: string | null;
  status: string | null;
};

type Props = {
  room: Room;
  isAdmin: boolean;
};

export default function RoomDetailsCard({
  room,
  isAdmin,
}: Props) {

  const status =
    room.status?.trim().toUpperCase();

  const isAvailable =
    status === "AVAILABLE";

  return (
    <div className="space-y-8">

      {/* Room Information */}

      <div className="rounded-2xl border bg-white p-8 shadow">

        <h2 className="mb-6 text-2xl font-bold">
          Room Information
        </h2>

        <div className="grid gap-5 md:grid-cols-2">

          <div className="flex items-center gap-3">

            <Building2 className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Room Name
              </p>

              <p className="font-semibold">
                {room.roomName}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <Users className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Capacity
              </p>

              <p className="font-semibold">
                {room.capacity}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <MapPin className="text-blue-600" />

            <div>

              <p className="text-sm text-gray-500">
                Location
              </p>

              <p className="font-semibold">
                {room.location || "Not Available"}
              </p>

            </div>

          </div>

          <div className="flex items-center gap-3">

            <BadgeCheck
              className={
                isAvailable
                  ? "text-green-600"
                  : status === "MAINTENANCE"
                  ? "text-yellow-600"
                  : "text-red-600"
              }
            />

            <div>

              <p className="text-sm text-gray-500">
                Status
              </p>

              <span
                className={`rounded-full px-3 py-1 text-sm font-medium ${
                  isAvailable
                    ? "bg-green-100 text-green-700"
                    : status === "MAINTENANCE"
                    ? "bg-yellow-100 text-yellow-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {room.status}
              </span>

            </div>

          </div>

        </div>

      </div>

      {/* Facilities */}

      <div className="rounded-2xl border bg-white p-8 shadow">

        <h2 className="mb-6 text-2xl font-bold">
          Facilities
        </h2>

        <div className="flex items-start gap-3">

          <ClipboardList className="mt-1 text-blue-600" />

          <p>
            {room.facilities || "No facilities available"}
          </p>

        </div>

      </div>

      {/* Description */}

      <div className="rounded-2xl border bg-white p-8 shadow">

        <h2 className="mb-6 text-2xl font-bold">
          Description
        </h2>

        <p className="text-gray-700">
          {room.description || "No description available"}
        </p>

      </div>

      {/* Warning */}

      {!isAvailable && (

        <div className="rounded-xl border border-yellow-300 bg-yellow-50 p-4 text-yellow-700">

          This room is currently unavailable for booking.

        </div>

      )}

      {/* Buttons */}

      <div className="flex gap-4">

        <Link href="/rooms">

          <Button variant="outline">
            Back
          </Button>

        </Link>

        {isAdmin && (

  <Link href={`/rooms/${room.roomId}/edit`}>

    <Button variant="secondary">
      Edit Room
    </Button>

  </Link>

)}

        {isAvailable ? (

  <Link href={`/rooms/${room.roomId}/book`}>

    <Button>
      Book Room
    </Button>

  </Link>

) : (

  <Button disabled>

    Book Room

  </Button>

)}
      </div>

    </div>
  );
}