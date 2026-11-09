import { NextResponse } from "next/server";
import { z } from "zod";

import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import { MAX_INT4 } from "@/lib/constants";
import { requireAdmin } from "@/lib/permissions";
import {
  OnlineMeetingError,
  adminRetryOnlineMeeting,
} from "@/lib/services/online-meeting.service";

const bodySchema = z.object({
  meetingId: z.number().int().min(1).max(MAX_INT4),
});

// Puts one meeting's FAILED Teams provisioning back in the background queue
// with fresh attempts. Admin role only. Only FAILED rows change, so this
// never races the worker.
export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "teams-admin", 30);

    if (blocked) return blocked;

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = bodySchema.safeParse(body.data);

    if (!parsed.success) return jsonError(400, "Invalid request.");

    const result = await adminRetryOnlineMeeting(
      parsed.data.meetingId,
      guard.organizer.employeeId
    );

    return NextResponse.json({ success: true, ...result }, { status: 202 });
  } catch (error) {
    if (error instanceof OnlineMeetingError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
