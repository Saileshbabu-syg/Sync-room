import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarClock, CalendarCheck, DoorOpen, ExternalLink, User } from "lucide-react";

import { auth } from "@/auth";
import { parseIdParam } from "@/lib/api";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { APP_TIMEZONE } from "@/lib/constants";
import { getRoomRequestFor } from "@/lib/services/room-request.service";

import CancelRoomRequestButton from "@/components/CancelRoomRequestButton";
import RoomRequestPanel from "@/components/RoomRequestPanel";
import RoomRequestStatusBadge from "@/components/RoomRequestStatusBadge";
import { Button } from "@/components/ui/button";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ intent?: string }>;
};

const whenFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

// Opened from the e-mail link. It only SHOWS the request (and, for the
// organizer, the decision form): nothing is approved or rejected by opening
// it. Only the requester and the organizer of the booked meeting can see it.
export default async function RoomRequestPage({ params, searchParams }: Props) {
  const session = await auth();

  if (!session) redirect("/login");

  const currentUser = await getCurrentUserProfile();

  if (!currentUser) redirect("/login");

  const requestId = parseIdParam((await params).id);

  if (requestId === null) notFound();

  const request = await getRoomRequestFor(requestId, currentUser.employeeId);

  // Missing and not-yours look the same.
  if (!request) notFound();

  const { intent } = await searchParams;

  const organizers = [...new Set(request.holders.map((h) => h.organizerName))];

  return (
    <div className="mx-auto max-w-5xl space-y-8" data-testid="room-request-detail">
      {/* Header: what this is, where it stands, and the one action the
          requester can take. */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-500">
            Room request #{request.requestId}
          </p>

          <h1 className="text-3xl font-bold tracking-tight">{request.roomName}</h1>

          <RoomRequestStatusBadge status={request.status} />
        </div>

        {request.canCancel && (
          <div className="shrink-0">
            <CancelRoomRequestButton requestId={request.requestId} />
          </div>
        )}
      </header>

      {request.status === "AWAITING_SLOT" && request.viewerIsRequester && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Everyone agreed, but an existing booking still holds the room. Your
          meeting is booked automatically as soon as it is free. Nothing is
          booked yet.
        </p>
      )}

      {request.status === "APPROVED" && request.resultingMeetingId && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          <span className="flex items-center gap-2 font-medium">
            <CalendarCheck className="size-4" />
            The meeting is booked.
          </span>

          <Button asChild size="sm">
            <Link href={`/bookings/${request.resultingMeetingId}`}>
              View confirmed booking
              <ExternalLink className="size-3.5" />
            </Link>
          </Button>
        </div>
      )}

      {/* Details */}
      <section aria-label="Request details" className="rounded-2xl border bg-white">
        <dl className="grid divide-y sm:grid-cols-2 sm:divide-y-0">
          <Field
            icon={<User className="size-4" />}
            label="Requested by"
            value={request.requesterName}
            hint={request.viewerIsOrganizer ? request.requesterEmail : undefined}
          />
          <Field
            icon={<User className="size-4" />}
            label={organizers.length > 1 ? "Current organizers" : "Current organizer"}
            value={organizers.join(", ")}
          />
          <Field
            icon={<DoorOpen className="size-4" />}
            label="Room"
            value={request.roomName}
          />
          <Field
            icon={<CalendarClock className="size-4" />}
            label="Requested time"
            value={`${request.meetingDate}, ${request.startTime} – ${request.endTime}`}
            hint={APP_TIMEZONE}
          />
          {request.holders
            .filter((h) => h.own)
            .map((h) => (
              <Field
                key={h.meetingId}
                label="Your meeting in the way"
                value={`${h.title}, ${h.startTime} – ${h.endTime}`}
              />
            ))}
          <Field label="Meeting they want to book" value={request.title} />
          <Field
            label="Submitted"
            value={request.createdAt ? whenFormat.format(request.createdAt) : "—"}
          />
          {request.respondedAt && (
            <Field label="Last decision" value={whenFormat.format(request.respondedAt)} />
          )}
        </dl>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Message from {request.requesterName}</h2>

        <p
          className="whitespace-pre-wrap rounded-xl border bg-slate-50 p-4 text-sm leading-relaxed"
          data-testid="request-message"
        >
          {request.message}
        </p>
      </section>

      {request.holders.length > 1 && (
        <section data-testid="holder-approvals" className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">
              Bookings in the way ({request.holders.length})
            </h2>

            <p className="mt-1 text-sm text-gray-500">
              Every organizer must agree, and every booking must be gone, before
              the room is booked.
            </p>
          </div>

          <ul className="space-y-2">
            {request.holders.map((h) => (
              <li
                key={h.meetingId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-white px-4 py-3 text-sm"
              >
                <span className="font-medium">
                  {h.own ? "You" : h.organizerName}
                  {h.own && h.title ? ` — ${h.title}` : ""}
                </span>

                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    h.status === "APPROVED"
                      ? "bg-green-50 text-green-800"
                      : h.status === "REJECTED"
                        ? "bg-red-50 text-red-800"
                        : "bg-amber-50 text-amber-800"
                  }`}
                >
                  {h.status === "APPROVED"
                    ? `Approved${h.holdsRoom ? ", booking still in place" : ", booking released"}`
                    : h.status === "REJECTED"
                      ? "Rejected"
                      : "Waiting"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {request.rejectionReason && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Reason given</h2>

          <p className="whitespace-pre-wrap rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            {request.rejectionReason}
          </p>
        </section>
      )}

      <RoomRequestPanel
        requestId={request.requestId}
        canDecide={request.canDecide}
        canRelease={request.canRelease}
        myBookings={request.holders
          .filter((h) => h.own)
          .map((h) => ({ title: h.title ?? "", holdsRoom: h.holdsRoom }))}
        otherOrganizers={
          new Set(request.holders.filter((h) => !h.own).map((h) => h.organizerName))
            .size
        }
        initialIntent={
          intent === "approve" || intent === "reject" ? intent : undefined
        }
      />
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="space-y-1 p-5 sm:border-b sm:border-r sm:[&:nth-child(2n)]:border-r-0">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">
        {icon}
        {label}
      </dt>

      <dd className="font-medium text-gray-900">{value}</dd>

      {hint && <dd className="text-xs text-gray-500">{hint}</dd>}
    </div>
  );
}
