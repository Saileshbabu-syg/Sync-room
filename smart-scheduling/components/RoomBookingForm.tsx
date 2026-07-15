"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { CalendarSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  room: {
    room_id: number;
    room_name: string;
    room_capacity: number;
  };
  organizerEmployeeId: number;
};

export default function RoomBookingForm({
  room,
}: Props) {

  const router = useRouter();

  const [loading, setLoading] =
    useState(false);

  const [bookedSlots, setBookedSlots] =
    useState<any[]>([]);

  const [formData, setFormData] =
    useState({
      meetingDate: "",
      startTime: "",
      endTime: "",
      participantCount: "",
    });

  const today = new Date()
    .toISOString()
    .split("T")[0];

  const maxDate = new Date();

  maxDate.setMonth(
    maxDate.getMonth() + 3
  );

  const maxDateString =
    maxDate
      .toISOString()
      .split("T")[0];

  const now = new Date();

  const minimumTime = new Date(
    now.getTime() + 15 * 60000
  );

  const minimumTimeString =
    minimumTime
      .toTimeString()
      .slice(0, 5);

  const handleChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {

    const { name, value } =
      e.target;

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    if (name === "meetingDate") {

      try {

        const response = await fetch(
          `/api/rooms/${room.room_id}/schedule?date=${value}`
        );

        const result =
          await response.json();

        if (result.success) {

          setBookedSlots(
            result.data
          );

        } else {

          setBookedSlots([]);

        }

      } catch {

        setBookedSlots([]);

      }

    }

  };

  const handleContinue = async () => {

    if (
      !formData.meetingDate ||
      !formData.startTime ||
      !formData.endTime ||
      !formData.participantCount
    ) {
      alert(
        "Please fill all required fields."
      );
      return;
    }

    const todayDate = new Date();

    todayDate.setHours(
      0,
      0,
      0,
      0
    );

    const selectedDate =
      new Date(
        formData.meetingDate
      );

    const maximumDate =
      new Date();

    maximumDate.setMonth(
      maximumDate.getMonth() + 3
    );

    if (
      selectedDate < todayDate ||
      selectedDate > maximumDate
    ) {
      alert(
        "Meeting date must be between today and the next 3 months."
      );
      return;
    }

    const current =
      new Date();

    const selectedStart =
      new Date(
        `${formData.meetingDate}T${formData.startTime}`
      );

    const minimumStart =
      new Date(
        current.getTime() +
          15 * 60000
      );

    if (
      selectedDate.toDateString() ===
        current.toDateString() &&
      selectedStart <
        minimumStart
    ) {
      alert(
        "Start time must be at least 15 minutes from now."
      );
      return;
    }

    if (
      Number(
        formData.participantCount
      ) >
      room.room_capacity
    ) {
      alert(
        `Room capacity is only ${room.room_capacity}.`
      );
      return;
    }

    if (
      formData.startTime >=
      formData.endTime
    ) {
      alert(
        "End time must be after Start time."
      );
      return;
    }

    setLoading(true);

    try {

      const response =
        await fetch(
          "/api/meetings/suggestions",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              room_id:
                room.room_id,

              meeting_date:
                formData.meetingDate,

              start_time:
                formData.startTime,

              end_time:
                formData.endTime,

              participant_count:
                Number(
                  formData.participantCount
                ),
            }),
          }
        );

      const result =
        await response.json();

      if (!response.ok) {
        alert(
          result.message
        );
        return;
      }

      const query =
        new URLSearchParams({
          roomId:
            room.room_id.toString(),

          roomName:
            room.room_name,

          date:
            formData.meetingDate,

          start:
            formData.startTime,

          end:
            formData.endTime,

          participants:
            formData.participantCount,
        });

      router.push(
        `/booking/details?${query.toString()}`
      );

    } catch (error) {

      console.error(error);

      alert(
        "Something went wrong."
      );

    } finally {

      setLoading(false);

    }

  };

    return (
    <div className="rounded-xl border bg-white p-8 shadow">

      <h1 className="mb-8 text-3xl font-bold">
        Book Room
      </h1>

      <div className="space-y-6">

        <div>

          <Label>
            Room
          </Label>

          <Input
            value={room.room_name}
            readOnly
          />

        </div>

        <div>

          <Label>
            Capacity
          </Label>

          <Input
            value={room.room_capacity}
            readOnly
          />

        </div>

        <div>

          <Label>
            Meeting Date
          </Label>

          <Input
            type="date"
            name="meetingDate"
            value={formData.meetingDate}
            min={today}
            max={maxDateString}
            onChange={handleChange}
          />

        </div>

        {/* Booked Time Slots */}

        <div>

          <Label>
            Booked Time Slots
          </Label>

          {formData.meetingDate === "" ? (

            <p className="mt-2 text-sm text-gray-500">
              Select a date to view booked slots.
            </p>

          ) : bookedSlots.length === 0 ? (

            <p className="mt-2 rounded-lg bg-green-50 p-3 text-green-700">
              Room is available for the entire day.
            </p>

          ) : (

            <div className="mt-3 space-y-2">

              {bookedSlots.map(
                (slot, index) => (

                  <div
                    key={index}
                    className="rounded-lg bg-red-50 px-4 py-3 text-red-700"
                  >

                    <p className="font-semibold">

                      {slot.startTime}
                      {" - "}
                      {slot.endTime}

                    </p>

                    <p className="text-sm">

                      {slot.title}

                    </p>

                  </div>

                )
              )}

            </div>

          )}

        </div>

        <div>

          <Label>
            Participant Count
          </Label>

          <Input
            type="number"
            min={1}
            name="participantCount"
            value={formData.participantCount}
            onChange={handleChange}
          />

        </div>

        <div>

          <Label>
            Start Time
          </Label>

          <Input
            type="time"
            name="startTime"
            value={formData.startTime}
            min={
              formData.meetingDate === today
                ? minimumTimeString
                : undefined
            }
            onChange={handleChange}
          />

        </div>

        <div>

          <Label>
            End Time
          </Label>

          <Input
            type="time"
            name="endTime"
            value={formData.endTime}
            min={
              formData.startTime || undefined
            }
            onChange={handleChange}
          />

        </div>

        <Button
          className="w-full"
          onClick={handleContinue}
          disabled={loading}
        >

          <CalendarSearch className="mr-2 h-5 w-5" />

          {loading
            ? "Checking..."
            : "Continue"}

        </Button>

      </div>

    </div>
  );
}