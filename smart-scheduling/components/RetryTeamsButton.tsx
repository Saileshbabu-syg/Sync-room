"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type Props = {
  meetingId: number;
};

// Shown when Online Teams Meeting was requested but its creation FAILED (the
// background retries were used up). The booking is a normal meeting until a
// retry succeeds.
export default function RetryTeamsButton({ meetingId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const retry = async () => {
    setLoading(true);

    try {
      const response = await fetch(`/api/meetings/online/${meetingId}`, {
        method: "POST",
      });

      const result = await response.json();

      if (!response.ok) {
        toast.error(
          result.message ?? "The Teams meeting could not be created."
        );
        return;
      }

      toast.success(
        result.message ??
          "The Teams meeting is being created. Attendees will receive the link by e-mail."
      );
      router.refresh();
    } catch {
      toast.error("Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
      <p className="font-medium text-amber-900">
        The Microsoft Teams meeting could not be created for this booking.
      </p>

      <p className="mt-1 text-sm text-amber-800">
        The booking is a normal meeting for now. You can try again.
      </p>

      <Button
        className="mt-4"
        variant="outline"
        onClick={retry}
        disabled={loading}
        data-testid="retry-teams"
      >
        {loading ? "Creating..." : "Retry Teams meeting"}
      </Button>
    </div>
  );
}
