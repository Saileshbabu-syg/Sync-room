import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { APP_TIMEZONE } from "@/lib/constants";
import { listRoomRequests } from "@/lib/services/room-request.service";
import RoomRequestStatusBadge from "@/components/RoomRequestStatusBadge";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

const StatusBadge = RoomRequestStatusBadge;

const submittedFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  dateStyle: "medium",
});

export default async function RoomRequestsPage() {
  const session = await auth();

  if (!session) redirect("/login");

  const currentUser = await getCurrentUserProfile();

  if (!currentUser) redirect("/login");

  const { received, sent } = await listRoomRequests(currentUser.employeeId);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Room Requests</h1>

        <p className="mt-2 text-gray-500">
          Ask the organizer of a booked room for it, or answer people who asked
          for yours.
        </p>
      </div>

      <section className="space-y-4" data-testid="received-requests">
        <h2 className="text-xl font-semibold">Requests for your rooms</h2>

        {received.length === 0 && (
          <p className="text-gray-500">Nobody has asked for your rooms.</p>
        )}

        {received.map((r) => (
          <div
            key={r.requestId}
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="space-y-1">
              <p className="font-semibold">
                {r.requesterName} wants {r.roomName}
              </p>

              <p className="text-sm text-gray-600">
                {r.meetingDate}, {r.startTime} - {r.endTime}
              </p>

              <StatusBadge status={r.status} />
            </div>

            <Button
              asChild
              size="sm"
              variant={r.status === "PENDING" ? "default" : "outline"}
            >
              <Link href={`/requests/${r.requestId}`}>
                {r.status === "PENDING" ? "Review and decide" : "View"}
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        ))}
      </section>

      <section className="space-y-4" data-testid="sent-requests">
        <h2 className="text-xl font-semibold">Your requests</h2>

        {sent.length === 0 && (
          <p className="text-gray-500">
            You have not asked for any room. Choose an occupied room while
            booking a meeting to ask its organizer.
          </p>
        )}

        {sent.map((r) => (
          <div
            key={r.requestId}
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-white p-5 shadow-sm"
          >
            <div className="space-y-1">
              <p className="font-semibold">{r.roomName}</p>

              <p className="text-sm text-gray-600">
                {r.meetingDate}, {r.startTime} - {r.endTime} · Organizer:{" "}
                {r.organizerNames} · Sent{" "}
                {r.createdAt ? submittedFormat.format(r.createdAt) : "—"}
              </p>

              <StatusBadge status={r.status} />

              {r.rejectionReason && (
                <p className="text-sm text-red-800">
                  Reason: {r.rejectionReason}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={`/requests/${r.requestId}`}>Details</Link>
              </Button>

              {r.status === "APPROVED" && r.resultingMeetingId && (
                <Button asChild size="sm">
                  <Link href={`/bookings/${r.resultingMeetingId}`}>
                    View booking
                  </Link>
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
