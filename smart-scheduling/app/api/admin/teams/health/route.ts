import { NextResponse } from "next/server";

import { jsonError, rateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/permissions";
import { checkTeamsHealth } from "@/lib/services/teams-meeting.service";

// Read-only health of the Teams integration: configuration, sign-in, granted
// permission and access to the organizer mailbox. Creates nothing and never
// returns credentials or tokens. Admin role only.
export async function GET() {
  try {
    const guard = await requireAdmin();

    if (!guard.ok) return guard.response;

    // Each call signs in with Microsoft: keep it occasional.
    const limited = rateLimit(guard.organizer.employeeId, "teams-health", 6);

    if (limited) return limited;

    const health = await checkTeamsHealth();
    const healthy =
      health.configuration.ok &&
      health.authentication.ok === true &&
      health.permissions.ok === true &&
      health.mailbox.ok === true;

    return NextResponse.json({ success: true, healthy, health });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Teams health check failed");

    return jsonError(500, "Something went wrong.");
  }
}
