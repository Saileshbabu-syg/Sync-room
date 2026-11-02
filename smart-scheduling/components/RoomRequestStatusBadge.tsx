import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL } from "@/lib/services/room-request.service";

const STATUS_STYLE: Record<string, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-800",
  AWAITING_SLOT: "border-blue-200 bg-blue-50 text-blue-800",
  APPROVED: "border-green-200 bg-green-50 text-green-800",
  REJECTED: "border-red-200 bg-red-50 text-red-800",
  CANCELLED: "border-gray-200 bg-gray-100 text-gray-700",
  EXPIRED: "border-gray-200 bg-gray-100 text-gray-700",
  FAILED: "border-red-200 bg-red-50 text-red-800",
};

const DOT_STYLE: Record<string, string> = {
  PENDING: "bg-amber-500",
  AWAITING_SLOT: "bg-blue-500",
  APPROVED: "bg-green-500",
  REJECTED: "bg-red-500",
  CANCELLED: "bg-gray-400",
  EXPIRED: "bg-gray-400",
  FAILED: "bg-red-500",
};

// One look for a request's status everywhere (list and detail page).
export default function RoomRequestStatusBadge({
  status,
  className = "",
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={`h-6 gap-1.5 px-2.5 ${STATUS_STYLE[status] ?? ""} ${className}`}
      data-testid="request-status"
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${DOT_STYLE[status] ?? "bg-gray-400"}`}
      />
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
