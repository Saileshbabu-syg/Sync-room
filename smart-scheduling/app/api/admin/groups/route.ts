import { NextResponse } from "next/server";

import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import { requireGroupManagement } from "@/lib/permissions";
import {
  createGroup,
  GroupError,
  listGroups,
} from "@/lib/services/group.service";
import { createGroupSchema } from "@/lib/validations/group.validator";

export async function GET() {
  const guard = await requireGroupManagement();

  if (!guard.ok) return guard.response;

  return NextResponse.json({ success: true, groups: await listGroups() });
}

export async function POST(request: Request) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "groups", 60);

    if (blocked) return blocked;

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = createGroupSchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(
        400,
        parsed.error.issues[0]?.message ?? "Validation failed"
      );
    }

    const group = await createGroup(parsed.data, guard.organizer.employeeId);

    return NextResponse.json({ success: true, group }, { status: 201 });
  } catch (error) {
    if (error instanceof GroupError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
