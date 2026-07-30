"use client";

import { useRouter } from "next/navigation";

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
};

export default function CancelMeetingButton({
  meetingId,
}: Props) {

  const router = useRouter();

  const handleCancel = async () => {

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

        toast.error(
          result.message ||
            "Failed to cancel meeting."
        );

        return;

      }

      toast.success(
        "Meeting cancelled successfully."
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

      <AlertDialogContent>

        <AlertDialogHeader>

          <AlertDialogTitle>

            Cancel Meeting

          </AlertDialogTitle>

          <AlertDialogDescription>

            Are you sure you want to cancel this meeting?
            This action cannot be undone.

          </AlertDialogDescription>

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