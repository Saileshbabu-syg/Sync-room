"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

export default function RoomDetailsPage() {
  const params = useParams();
  const router = useRouter();

  const roomId = params.id;

  const [room, setRoom] = useState<any>(null);
  const [date, setDate] = useState("");
  const [bookings, setBookings] = useState<any[]>([]);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [error, setError] = useState("");

  // Fetch Room Details
  useEffect(() => {
    async function fetchRoom() {
      const response = await fetch(`/api/rooms/${roomId}`);
      const data = await response.json();

      setRoom(data);
    }

    fetchRoom();
  }, [roomId]);

  // Fetch Booked Slots when date changes
  useEffect(() => {
    async function fetchBookings() {
      if (!date) {
        setBookings([]);
        return;
      }

      const response = await fetch(
        `/api/rooms/${roomId}/bookings?date=${date}`
      );

      const data = await response.json();

console.log("Bookings:", data);

if (Array.isArray(data)) {
  setBookings(data);
} else {
  setBookings([]);
}
    }

    fetchBookings();
  }, [date, roomId]);

  async function handleContinue() {
    setError("");

    if (!date || !startTime || !endTime) {
      setError("Please fill all fields.");
      return;
    }

    const response = await fetch(
      `/api/check-availability?roomId=${roomId}&date=${date}&start=${startTime}&end=${endTime}`
    );

    const data = await response.json();

    if (!data.available) {
      setError(
        "Room is already booked during this timing."
      );
      return;
    }

    router.push(
  `/rooms/${roomId}/confirm?roomName=${encodeURIComponent(
    room.roomName
  )}&date=${date}&start=${startTime}&end=${endTime}`
);
  }

  if (!room) {
    return <div className="p-6">Loading...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto p-6">

      <h1 className="text-3xl font-bold mb-6">
        {room.roomName}
      </h1>

      <div className="border rounded p-4 mb-6">

        <p>
          <strong>Capacity:</strong>{" "}
          {room.roomCapacity}
        </p>

        <p>
          <strong>Location:</strong>{" "}
          {room.roomLocation}
        </p>

        <p>
          <strong>Facilities:</strong>{" "}
          {room.facilities}
        </p>

      </div>

      <div className="mb-6">

        <label className="font-semibold">
          Select Date
        </label>

        <input
          type="date"
          className="border p-2 w-full mt-2"
          value={date}
          onChange={(e) =>
            setDate(e.target.value)
          }
        />

      </div>

      {date && (
        <div className="border rounded p-4 mb-6">

          <h2 className="font-bold mb-2">
            Booked Slots
          </h2>

          {bookings.length === 0 ? (
            <p>No bookings for this date.</p>
          ) : (
            bookings.map((slot, index) => (
              <p key={index}>
                {slot.startTime} - {slot.endTime}
              </p>
            ))
          )}

        </div>
      )}

      <div className="mb-4">

        <label className="font-semibold">
          Start Time
        </label>

        <input
          type="time"
          className="border p-2 w-full mt-2"
          value={startTime}
          onChange={(e) =>
            setStartTime(e.target.value)
          }
        />

      </div>

      <div className="mb-4">

        <label className="font-semibold">
          End Time
        </label>

        <input
          type="time"
          className="border p-2 w-full mt-2"
          value={endTime}
          onChange={(e) =>
            setEndTime(e.target.value)
          }
        />

      </div>

      {error && (
        <p className="text-red-500 mb-4">
          {error}
        </p>
      )}

      <button
  onClick={handleContinue}
  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg shadow-md transition duration-200"
>
  Continue to Confirmation →
</button>
    </div>
  );
}