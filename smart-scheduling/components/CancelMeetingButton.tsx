"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

type Props = {
  meetingId: number;
};

export default function CancelMeetingButton({
  meetingId,
}: Props) {
  const router = useRouter();

  const handleCancel = async () => {
    const confirmed = window.confirm(
      "Are you sure you want to cancel this meeting?"
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(
        `/api/meetings/cancel/${meetingId}`,
        {
          method: "PATCH",
        }
      );

      const result =
        await response.json();

      if (!response.ok) {
        alert(result.message);
        return;
      }

      alert(result.message);

      router.refresh();

    } catch (error) {
      console.error(error);

      alert(
        "Unable to cancel meeting."
      );
    }
  };

  return (
    <Button
      variant="destructive"
      onClick={handleCancel}
    >
      Cancel
    </Button>
  );
}