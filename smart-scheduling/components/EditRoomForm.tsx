"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

import { formatDate, formatTimeRange } from "@/lib/format";

// Upcoming meetings that stop a room from being taken out of service.
type RoomConflict = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
};

type Props = {
  // "create": a new room (POST /api/rooms); default "edit".
  mode?: "edit" | "create";
  room: {
    room_id: number;
    room_name: string;
    room_capacity: number;
    roomLocation: string | null;
    facilities: string | null;
    roomDescription: string | null;
    availabilityStatusId: number | null;
  };

  availabilityStatuses: {
    availabilityStatusId: number;
    availabilityStatusName: string ;
  }[];
};

export default function EditRoomForm({
  mode = "edit",
  room,
  availabilityStatuses,
}: Props) {

  const creating = mode === "create";

  const [conflicts, setConflicts] = useState<RoomConflict[]>([]);

  const router = useRouter();

  const [loading, setLoading] =
    useState(false);

  const [formData, setFormData] =
    useState({

      room_name: room.room_name,

      room_capacity:
        room.room_capacity,

      roomLocation:
        room.roomLocation ?? "",

      facilities:
        room.facilities ?? "",

      roomDescription:
        room.roomDescription ?? "",

      availabilityStatusId:
        room.availabilityStatusId ?? 1,

    });

  const handleChange = (
    e:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLSelectElement>
  ) => {

    const { name, value } =
      e.target;

    setFormData((prev) => ({
      ...prev,

      [name]:
        name ===
          "room_capacity" ||
        name ===
          "availabilityStatusId"
          ? Number(value)
          : value,
    }));

  };

  const handleUpdate =
    async () => {

      if (
        !formData.room_name.trim()
      ) {
        toast.warning(
          "Room name is required."
        );
        return;
      }

      if (
        formData.room_capacity <= 0
      ) {
        toast.warning(
          "Capacity must be greater than zero."
        );
        return;
      }

      if (
        !formData.roomLocation.trim()
      ) {
        toast.warning(
          "Location is required."
        );
        return;
      }

      setLoading(true);
      setConflicts([]);

      try {

        const response = creating
          ? await fetch("/api/rooms", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                roomName: formData.room_name,
                roomCapacity: formData.room_capacity,
                roomLocation: formData.roomLocation,
                facilities: formData.facilities,
                roomDescription: formData.roomDescription,
                availabilityStatusId: formData.availabilityStatusId,
              }),
            })
          : await fetch(
            `/api/rooms/${room.room_id}/edit`,
            {
              method: "PATCH",

              headers: {
                "Content-Type":
                  "application/json",
              },

              body: JSON.stringify(
                formData
              ),
            }
          );

        const result =
          await response.json();

        if (!response.ok) {
          toast.error(
            result.message ?? "The room could not be saved."
          );
          // Meetings still booked in the room: listed below so they can be
          // moved or cancelled first (nothing was changed).
          setConflicts(Array.isArray(result.conflicts) ? result.conflicts : []);
          return;
        }

        toast.success(
          creating ? "Room created." : "Room updated successfully."
        );

        router.push("/rooms");

        router.refresh();

      } catch {

        toast.error(
          "Something went wrong."
        );

      } finally {

        setLoading(false);

      }

    };
      return (
    <div className="rounded-2xl border bg-white p-8 shadow">

      <h1 className="mb-8 text-3xl font-bold">
        {creating ? "Add Room" : "Edit Room"}
      </h1>

      {conflicts.length > 0 && (
        <div
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          role="alert"
          data-testid="room-conflicts"
        >
          <p className="font-medium">
            These meetings are still booked in this room. Move or cancel them
            first (as their organizer or an Admin), then try again:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {conflicts.map((c) => (
              <li key={c.meetingId}>
                <Link className="underline" href={`/bookings/${c.meetingId}`}>
                  {c.title}
                </Link>{" "}
                - {formatDate(c.meetingDate)}, {formatTimeRange(c.startTime, c.endTime)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-6">

        <div>

          <Label>
            Room Name
          </Label>

          <Input
            name="room_name"
            value={formData.room_name}
            onChange={handleChange}
          />

        </div>

        <div>

          <Label>
            Room Capacity
          </Label>

          <Input
            type="number"
            name="room_capacity"
            value={formData.room_capacity}
            onChange={handleChange}
          />

        </div>

        <div>

          <Label>
            Location
          </Label>

          <Input
            name="roomLocation"
            value={formData.roomLocation}
            onChange={handleChange}
          />

        </div>

        <div>

          <Label>
            Facilities
          </Label>

          <Input
            name="facilities"
            value={formData.facilities}
            onChange={handleChange}
          />

        </div>

        <div>

          <Label>
            Description
          </Label>

          <Input
            name="roomDescription"
            value={formData.roomDescription}
            onChange={handleChange}
          />

        </div>

        <div>

          <Label>
            Availability Status
          </Label>

          <select
            name="availabilityStatusId"
            value={formData.availabilityStatusId}
            onChange={handleChange}
            className="w-full rounded-md border p-2"
          >

            {availabilityStatuses.map(
              (status) => (

                <option
                  key={
                    status.availabilityStatusId
                  }
                  value={
                    status.availabilityStatusId
                  }
                >
                  {
                    status.availabilityStatusName
                  }
                </option>

              )
            )}

          </select>

        </div>

        <div className="flex gap-4 pt-4">

          <Button
            onClick={handleUpdate}
            disabled={loading}
          >

            {loading
              ? "Saving..."
              : creating ? "Create Room" : "Update Room"}

          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={() =>
              router.push("/rooms")
            }
          >

            Cancel

          </Button>

        </div>

      </div>

    </div>
  );
}