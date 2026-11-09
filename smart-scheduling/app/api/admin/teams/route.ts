import { NextRequest, NextResponse } from "next/server";

import { jsonError, rateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/permissions";
import {
  ONLINE_STATUS,
  listOnlineProvisioning,
} from "@/lib/services/online-meeting.service";

// Teams provisioning of meetings that still happen: counts per status and the
// records of one status (?status=FAILED by default, or PENDING / READY), with
// the meeting, attempt count, next retry and the last (safe) error. Admin role
// only.
export async function GET(req: NextRequest) {
  try {
    const guard = await requireAdmin();

    if (!guard.ok) return guard.response;

    const limited = rateLimit(guard.organizer.employeeId, "teams-admin", 30);

    if (limited) return limited;

    const status = req.nextUrl.searchParams.get("status") ?? ONLINE_STATUS.FAILED;

    if (!Object.values(ONLINE_STATUS).includes(status as never)) {
      return jsonError(400, "status must be NONE, PENDING, READY or FAILED.");
    }

    return NextResponse.json({
      success: true,
      ...(await listOnlineProvisioning(status as keyof typeof ONLINE_STATUS)),
    });
  } catch (error) {
    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
