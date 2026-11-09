"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Button } from "@/components/ui/button";
import { formatDate, formatTime } from "@/lib/format";

type Conflict = { meetingId: number; title: string; meetingDate: string; startTime: string };

// Archive (or restore) a room, after a confirmation. The server refuses to
// archive a room that still has meetings booked; they are listed.
export default function RoomArchiveButton({
  roomId,
  roomName,
  archived,
}: {
  roomId: number;
  roomName: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);

    try {
      const response = await fetch(`/api/rooms/${roomId}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const conflicts: Conflict[] = Array.isArray(result.conflicts) ? result.conflicts : [];

        toast.error(result.message ?? "The room could not be changed.", {
          description:
            conflicts.length > 0
              ? conflicts
                  .slice(0, 5)
                  .map((c) => `${c.title} (${formatDate(c.meetingDate)} ${formatTime(c.startTime)})`)
                  .join("; ") + (conflicts.length > 5 ? "; ..." : "")
              : undefined,
          duration: 12_000,
        });
        return;
      }

      toast.success(result.message ?? (archived ? "Room restored." : "Room archived."));
      router.refresh();
    } catch {
      toast.error("Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={archived ? "outline" : "destructive"} disabled={loading}>
          {archived ? "Restore" : "Archive"}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent size="confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{archived ? "Restore room" : "Archive room"}</AlertDialogTitle>

          <AlertDialogDescription>
            {archived
              ? `${roomName} will be bookable again.`
              : `${roomName} will no longer be offered or bookable. Past meetings keep it. A room with upcoming meetings cannot be archived.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            className={archived ? undefined : "bg-red-600 text-white hover:bg-red-700"}
          >
            {archived ? "Restore" : "Archive"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
