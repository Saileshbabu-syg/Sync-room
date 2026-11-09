"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import SeriesScopeSelect, { type SeriesScope } from "@/components/SeriesScopeSelect";

import { Button } from "@/components/ui/button";

import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type Props = {
  meetingId: number;
  // Part of a recurring series: offer this / this and following / all.
  inSeries?: boolean;
};

export default function CancelMeetingButton({
  meetingId,
  inSeries = false,
}: Props) {

  const router = useRouter();

  const [scope, setScope] = useState<SeriesScope>("single");

  const handleCancel = async () => {

    try {

      const response = await fetch(
        `/api/meetings/cancel/${meetingId}${inSeries ? `?scope=${scope}` : ""}`,
        {
          method: "PATCH",
        }
      );

      const result =
        await response.json();

      if (!response.ok) {

        toast.error(
          result.message ||
            "Failed to cancel meeting."
        );

        return;

      }

      toast.success(
        result.message || "Meeting cancelled successfully."
      );

      router.refresh();

    } catch {

      toast.error(
        "Something went wrong."
      );

    }

  };

  return (

    <AlertDialog>

      <AlertDialogTrigger asChild>

        <Button variant="destructive">

          Cancel

        </Button>

      </AlertDialogTrigger>

      <AlertDialogContent compact>

        <AlertDialogHeader>

          <AlertDialogTitle>

            Cancel Meeting

          </AlertDialogTitle>

          <AlertDialogDescription>

            Are you sure you want to cancel this meeting?
            This action cannot be undone.

          </AlertDialogDescription>

          {inSeries && (
            <SeriesScopeSelect
              value={scope}
              onChange={setScope}
              name={`cancel-scope-${meetingId}`}
            />
          )}

        </AlertDialogHeader>

        <AlertDialogFooter>

          <AlertDialogCancel>

            No

          </AlertDialogCancel>

          <AlertDialogAction
            onClick={handleCancel}
          >

            Yes, Cancel

          </AlertDialogAction>

        </AlertDialogFooter>

      </AlertDialogContent>

    </AlertDialog>

  );

}