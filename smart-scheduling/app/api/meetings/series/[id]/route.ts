import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
  readJson,
} from "@/lib/api";
import {
  changeSeriesEnd,
  getSeriesDetails,
  lifecycleError,
} from "@/lib/services/series.service";

// The recurring series that meeting `id` belongs to.
//   GET   -> its pattern (frequency, every-N-weeks, start, end-by date), its
//            skipped dates and every occurrence. Organizer, Admin or attendee.
//   PATCH -> { end_date }: shortens or extends the series. Organizer or Admin.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) return jsonError(401, "Unauthorized");

    const meetingId = parseIdParam((await params).id);

    if (meetingId === null) return jsonError(400, "Invalid meeting id.");

    const series = await getSeriesDetails(meetingId, {
      employeeId: organizer.employeeId,
      role: organizer.role,
    });

    return NextResponse.json({ success: true, series });
  } catch (error) {
    const known = lifecycleError(error);

    if (known) return jsonError(known.status, known.message);

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}

const endSchema = z.object({
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end_date must be in YYYY-MM-DD format"),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) return jsonError(401, "Unauthorized");

    const blocked =
      guardMutation(req) ?? rateLimit(organizer.employeeId, "edit", 30);

    if (blocked) return blocked;

    const meetingId = parseIdParam((await params).id);

    if (meetingId === null) return jsonError(400, "Invalid meeting id.");

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const parsed = endSchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(400, parsed.error.issues[0]?.message ?? "Validation failed");
    }

    const result = await changeSeriesEnd({
      meetingId,
      endDate: parsed.data.end_date,
      actor: { employeeId: organizer.employeeId, role: organizer.role },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const known = lifecycleError(error);

    if (known) return jsonError(known.status, known.message);

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
