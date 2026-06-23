"use client";

import { useSearchParams } from "next/navigation";

export default function ConfirmPage() {
  const params = useSearchParams();

  return (
    <div className="p-6">

      <h1 className="text-3xl font-bold mb-6">
        Booking Confirmation
      </h1>

      <p>
        Date: {params.get("date")}
      </p>

      <p>
        Start: {params.get("start")}
      </p>

      <p>
        End: {params.get("end")}
      </p>

      <p className="mt-4">
        Booking storage will be implemented later.
      </p>

    </div>
  );
}