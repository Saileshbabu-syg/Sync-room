"use client";

import ErrorState from "@/components/ErrorState";

// Next.js 16.3+ passes `retry` (the former `unstable_retry` is no longer
// passed, so "Try again" used to throw here).
export default function AvailableRoomsError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <ErrorState
      title="Could not load available rooms"
      message="Something went wrong while checking room availability. Please try again."
      error={error}
      retry={retry}
    />
  );
}
