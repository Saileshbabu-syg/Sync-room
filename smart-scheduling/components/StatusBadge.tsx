import { Loader2, TriangleAlert } from "lucide-react";

import { MEETING_STATUS, MEETING_STATUS_LABEL } from "@/lib/constants";
import { cn } from "@/lib/utils";

// One colour per meeting status, used on every page (My Bookings, the details
// page, Today's Schedule and the dashboard), keyed by the status id so the
// label's spelling or casing never changes the colour.
const STATUS_STYLE: Record<number, string> = {
  [MEETING_STATUS.SCHEDULED]: "border-green-200 bg-green-100 text-green-800",
  [MEETING_STATUS.COMPLETED]: "border-slate-200 bg-slate-100 text-slate-700",
  [MEETING_STATUS.CANCELLED]: "border-red-200 bg-red-100 text-red-800",
  [MEETING_STATUS.PENDING_RESCHEDULE]: "border-amber-200 bg-amber-100 text-amber-900",
  [MEETING_STATUS.PREEMPTED]: "border-orange-200 bg-orange-100 text-orange-900",
};

const badge = "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold";

export function StatusBadge({
  statusId,
  className,
}: {
  statusId: number;
  className?: string;
}) {
  return (
    <span
      className={cn(badge, STATUS_STYLE[statusId] ?? "border-gray-200 bg-gray-100 text-gray-700", className)}
      data-testid="status-badge"
      data-status-id={statusId}
    >
      {MEETING_STATUS_LABEL[statusId] ?? "Unknown"}
    </span>
  );
}

// The Teams link of an online meeting while it is not ready yet: being
// created (PENDING) or given up on (FAILED, the organizer can retry). Nothing
// is shown for a ready link or an in-person meeting.
export function TeamsStatusBadge({
  onlineRequested,
  onlineStatus,
  className,
}: {
  onlineRequested?: boolean;
  onlineStatus?: string | null;
  className?: string;
}) {
  if (!onlineRequested) return null;

  if (onlineStatus === "PENDING") {
    return (
      <span
        className={cn(badge, "border-blue-200 bg-blue-50 text-blue-800", className)}
        data-testid="teams-status"
        title="The Microsoft Teams link is being prepared"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Teams link pending
      </span>
    );
  }

  if (onlineStatus === "FAILED") {
    return (
      <span
        className={cn(badge, "border-red-200 bg-red-50 text-red-800", className)}
        data-testid="teams-status"
        title="The Microsoft Teams link could not be created"
      >
        <TriangleAlert className="h-3 w-3" aria-hidden />
        Teams link failed
      </span>
    );
  }

  return null;
}
