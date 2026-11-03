import { NextResponse } from "next/server";

import { guardMutation, jsonError, rateLimit } from "@/lib/api";
import { requireGroupManagement } from "@/lib/permissions";
import {
  getSyncStatus,
  SyncError,
  syncEmployees,
} from "@/lib/services/entra-sync.service";

// Progress and the last result, for the Employees tab.
export async function GET() {
  const guard = await requireGroupManagement();

  if (!guard.ok) return guard.response;

  return NextResponse.json({ success: true, ...(await getSyncStatus()) });
}

// Runs a sync now. Admin only; one at a time (a second call gets 409).
export async function POST(request: Request) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "entra-sync", 5);

    if (blocked) return blocked;

    const summary = await syncEmployees({
      actorEmployeeId: guard.organizer.employeeId,
    });

    return NextResponse.json({ success: true, summary });
  } catch (error) {
    if (error instanceof SyncError) return jsonError(error.status, error.message);

    console.error(error);

    return jsonError(500, "The sync failed.");
  }
}
