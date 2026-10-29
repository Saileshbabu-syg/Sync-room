"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Props = {
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
  room,
  availabilityStatuses,
}: Props) {

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

      try {

        const response =
          await fetch(
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
            result.message
          );
          return;
        }

        toast.success(
          "Room updated successfully."
        );

        router.push(
          `/rooms/${room.room_id}`
        );

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
        Edit Room
      </h1>

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
              ? "Updating..."
              : "Update Room"}

          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={() =>
              router.push(
                `/rooms/${room.room_id}`
              )
            }
          >

            Cancel

          </Button>

        </div>

      </div>

    </div>
  );
}