"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Mode = "approve" | "reject" | null;

type Props = {
  requestId: number;
  // What the signed-in user may do right now (the server checks again).
  canDecide: boolean; //  organizer, request still PENDING
  canRelease: boolean; // organizer, approved and waiting for the room
  // The viewer's own bookings in the way, and whether each still holds the
  // room. Only these can be released by them.
  myBookings: { title: string; holdsRoom: boolean }[];
  // Other organizers who also have a booking in the way.
  otherOrganizers: number;
  // From the e-mail's Approve / Reject link: opens that form, decides nothing.
  initialIntent?: "approve" | "reject";
};

const REASON_MAX = 500;

export default function RoomRequestPanel({
  requestId,
  canDecide,
  canRelease,
  myBookings,
  otherOrganizers,
  initialIntent,
}: Props) {
  const router = useRouter();

  const holding = myBookings.filter((b) => b.holdsRoom);
  const holdingText = holding.map((b) => `"${b.title}"`).join(", ");
  const holderStillHoldsRoom = holding.length > 0;
  const [mode, setMode] = useState<Mode>(canDecide ? (initialIntent ?? null) : null);
  const [releaseBooking, setReleaseBooking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);

    try {
      const response = await fetch(`/api/room-requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (response.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message ?? "Something went wrong.");
      }

      // Refresh either way: it may have been answered in another tab.
      setMode(null);
      router.refresh();
    } catch {
      toast.error("Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  if (!canDecide && !canRelease) return null;

  return (
    <div className="space-y-4 rounded-xl border bg-slate-50 p-5" data-testid="request-panel">
      {canDecide && (
        <>
          <div className="flex gap-3">
            <Button
              variant={mode === "approve" ? "default" : "outline"}
              onClick={() => setMode("approve")}
              disabled={busy}
            >
              Approve Request
            </Button>

            <Button
              variant={mode === "reject" ? "destructive" : "outline"}
              onClick={() => setMode("reject")}
              disabled={busy}
            >
              Reject Request
            </Button>
          </div>

          {mode === "approve" && (
            <div className="space-y-3 text-sm" data-testid="approve-form">
              {holderStillHoldsRoom ? (
                <p>
                  Your {holding.length > 1 ? "bookings" : "booking"} {holdingText}{" "}
                  still {holding.length > 1 ? "hold" : "holds"} this room, so
                  approving will <strong>not</strong> book it for them yet and
                  will not cancel your meeting. You can release{" "}
                  {holding.length > 1 ? "them" : "it"} now, or cancel{" "}
                  {holding.length > 1 ? "them" : "it"} yourself later.
                </p>
              ) : (
                <p>
                  Your booking no longer holds this room, so approving books it
                  for them right away.
                </p>
              )}

              {otherOrganizers > 0 && (
                <p className="rounded-md bg-amber-50 p-3 text-amber-900">
                  {otherOrganizers} other organizer{otherOrganizers > 1 ? "s" : ""}{" "}
                  also {otherOrganizers > 1 ? "have" : "has"} a booking in this
                  room at that time. The room is booked for the requester only
                  when every organizer agrees and it is free.
                </p>
              )}

              {holderStillHoldsRoom && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={releaseBooking}
                    onChange={(e) => setReleaseBooking(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    Also cancel my {holding.length > 1 ? "bookings" : "booking"}{" "}
                    {holdingText} for this date only. Other dates of a
                    recurring meeting are not affected.
                  </span>
                </label>
              )}

              <Button
                disabled={busy}
                onClick={() =>
                  send({ action: "approve", release_booking: releaseBooking })
                }
              >
                {busy ? "Working..." : "Confirm approval"}
              </Button>
            </div>
          )}

          {mode === "reject" && (
            <div className="space-y-3 text-sm" data-testid="reject-form">
              <div>
                <Label htmlFor="rejectReason">Reason (optional)</Label>

                <textarea
                  id="rejectReason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={REASON_MAX}
                  rows={3}
                  className="mt-2 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  placeholder="Shown to the person who asked"
                />
              </div>

              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  send({
                    action: "reject",
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  })
                }
              >
                {busy ? "Working..." : "Confirm rejection"}
              </Button>
            </div>
          )}
        </>
      )}

      {canRelease && (
        <div className="space-y-3 text-sm" data-testid="release-form">
          <p>
            You approved this request, but your{" "}
            {holding.length > 1 ? "bookings" : "booking"} {holdingText} still{" "}
            {holding.length > 1 ? "hold" : "holds"} the room. Their meeting is
            booked as soon as every booking in the way is gone: cancel{" "}
            {holding.length > 1 ? "them" : "it"}, or release{" "}
            {holding.length > 1 ? "them" : "it"} here (this date only).
          </p>

          <Button disabled={busy} onClick={() => send({ action: "release" })}>
            {busy ? "Working..." : "Release my booking(s) for them"}
          </Button>
        </div>
      )}
    </div>
  );
}
