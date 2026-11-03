import { NextResponse } from "next/server";

import { jsonError, rateLimit } from "@/lib/api";
import { requireGroupManagement } from "@/lib/permissions";
import { fetchEntraGroups, SyncError } from "@/lib/services/entra-sync.service";

// The directory security groups, for the mapping picker.
export async function GET() {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const limited = rateLimit(guard.organizer.employeeId, "entra-groups", 20);

    if (limited) return limited;

    return NextResponse.json({ success: true, groups: await fetchEntraGroups() });
  } catch (error) {
    if (error instanceof SyncError) return jsonError(error.status, error.message);

    console.error(error);

    return jsonError(500, "Could not read the directory groups.");
  }
}
