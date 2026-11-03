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
  deleteGroup,
  GroupError,
  updateGroup,
} from "@/lib/services/group.service";
import { updateGroupSchema } from "@/lib/validations/group.validator";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "groups", 60);

    if (blocked) return blocked;

    const groupId = parseIdParam((await params).id);

    if (groupId === null) return jsonError(400, "Invalid group id.");

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = updateGroupSchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(
        400,
        parsed.error.issues[0]?.message ?? "Validation failed"
      );
    }

    const group = await updateGroup(
      groupId,
      parsed.data,
      guard.organizer.employeeId
    );

    return NextResponse.json({ success: true, group });
  } catch (error) {
    if (error instanceof GroupError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request, { expectJson: false }) ??
      rateLimit(guard.organizer.employeeId, "groups", 60);

    if (blocked) return blocked;

    const groupId = parseIdParam((await params).id);

    if (groupId === null) return jsonError(400, "Invalid group id.");

    await deleteGroup(groupId, guard.organizer.employeeId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof GroupError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
