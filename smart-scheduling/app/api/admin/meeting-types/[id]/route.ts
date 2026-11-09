import { NextResponse } from "next/server";

import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
  readJson,
} from "@/lib/api";
import { requireGroupManagement } from "@/lib/permissions";
import {
  GroupError,
  updateMeetingTypePriority,
} from "@/lib/services/group.service";
import { updateMeetingTypeSchema } from "@/lib/validations/group.validator";

type Params = { params: Promise<{ id: string }> };

// Changes how a meeting type ranks against others when two bookings want the
// same room. Needs the Group Management permission, like the rest of /admin.
export async function PATCH(request: Request, { params }: Params) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "meeting-types", 60);

    if (blocked) return blocked;

    const typeId = parseIdParam((await params).id);

    if (typeId === null) return jsonError(400, "Invalid meeting type id.");

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = updateMeetingTypeSchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(
        400,
        parsed.error.issues[0]?.message ?? "Validation failed"
      );
    }

    const meetingType = await updateMeetingTypePriority(
      typeId,
      parsed.data.priorityRank,
      guard.organizer.employeeId
    );

    return NextResponse.json({ success: true, meetingType });
  } catch (error) {
    if (error instanceof GroupError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
