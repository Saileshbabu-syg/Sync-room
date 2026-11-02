"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// The requester's "Cancel Request". The server decides whether it is still
// allowed; the page is refreshed either way because the request may have been
// answered in another tab.
export default function CancelRoomRequestButton({
  requestId,
}: {
  requestId: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  const cancel = async () => {
    if (sending.current) return;

    sending.current = true;
    setBusy(true);

    try {
      const response = await fetch(`/api/room-requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });

      const result = await response.json().catch(() => ({}));

      if (response.ok) {
        toast.success(result.message ?? "Request cancelled.");
      } else {
        toast.error(result.message ?? "Could not cancel the request.");
      }

      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Something went wrong.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
        onClick={() => setOpen(true)}
        disabled={busy}
        data-testid="cancel-request"
      >
        Cancel Request
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogContent compact>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this request?</AlertDialogTitle>

            <AlertDialogDescription>
              The organizer will no longer be asked for the room. Nothing is
              booked for you, and you can send a new request later.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep request</AlertDialogCancel>

            <Button
              variant="destructive"
              onClick={cancel}
              disabled={busy}
              data-testid="confirm-cancel-request"
            >
              {busy ? "Cancelling..." : "Yes, cancel request"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
