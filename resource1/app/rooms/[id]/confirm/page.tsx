"use client";

import { useSearchParams } from "next/navigation";

export default function ConfirmPage() {
  const params = useSearchParams();

  return (
    <div className="max-w-2xl mx-auto p-6">

      <h1 className="text-3xl font-bold mb-6">
        Booking Confirmation
      </h1>

      <div className="border rounded-lg p-6 shadow">

        <p className="mb-3">
          <strong>Room Name:</strong> {params.get("roomName")}
        </p>

        <p className="mb-3">
          <strong>Date:</strong> {params.get("date")}
        </p>

        <p className="mb-3">
          <strong>Start Time:</strong> {params.get("start")}
        </p>

        <p className="mb-3">
          <strong>End Time:</strong> {params.get("end")}
        </p>

        {/* <p className="mb-3">
  <strong>Meeting Title:</strong> {params.get("title")}
</p>

<p className="mb-3">
  <strong>Meeting Type:</strong> {params.get("meetingTypeId")}
</p>

<p className="mb-3">
  <strong>Capacity:</strong> {params.get("capacity")}
</p> */}

      </div>

      <p className="mt-6 text-gray-600">
        Booking save functionality will be added later.
      </p>

    </div>
  );
}