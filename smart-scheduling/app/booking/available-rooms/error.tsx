"use client";

export default function AvailableRoomsError({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="mx-auto max-w-xl p-10 text-center" role="alert">
      <h1 className="text-2xl font-bold">Could not load available rooms</h1>

      <p className="mt-2 text-gray-500">
        Something went wrong while checking room availability. Please try again.
      </p>

      <button
        type="button"
        onClick={() => unstable_retry()}
        className="mt-6 rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
      >
        Try again
      </button>
    </div>
  );
}
