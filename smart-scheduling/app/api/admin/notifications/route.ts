import { NextResponse } from "next/server";

import { jsonError, rateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/permissions";
import { listFailedDeliveries } from "@/lib/services/delivery-admin.service";

// E-mails (booking notifications and reminders) that were given up on, newest
// first, with the reason. Admin role only.
export async function GET() {
  try {
    const guard = await requireAdmin();

    if (!guard.ok) return guard.response;

    const limited = rateLimit(guard.organizer.employeeId, "failed-emails", 30);

    if (limited) return limited;

    return NextResponse.json({
      success: true,
      failed: await listFailedDeliveries(),
    });
  } catch (error) {
    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
