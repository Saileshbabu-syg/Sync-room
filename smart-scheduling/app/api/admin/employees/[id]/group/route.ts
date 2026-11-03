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
  assignEmployee,
  getEmployeeGroupHistory,
  GroupError,
  unassignEmployee,
} from "@/lib/services/group.service";
import { assignGroupSchema } from "@/lib/validations/group.validator";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const guard = await requireGroupManagement();

  if (!guard.ok) return guard.response;

  const employeeId = parseIdParam((await params).id);

  if (employeeId === null) return jsonError(400, "Invalid employee id.");

  return NextResponse.json({
    success: true,
    history: await getEmployeeGroupHistory(employeeId),
  });
}

// Assign, or move to a different group (history is kept).
export async function PUT(request: Request, { params }: Params) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "groups", 120);

    if (blocked) return blocked;

    const employeeId = parseIdParam((await params).id);

    if (employeeId === null) return jsonError(400, "Invalid employee id.");

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = assignGroupSchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(
        400,
        parsed.error.issues[0]?.message ?? "Validation failed"
      );
    }

    const result = await assignEmployee(
      employeeId,
      parsed.data.groupId,
      guard.organizer.employeeId
    );

    return NextResponse.json({ success: true, changed: result.changed });
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
      rateLimit(guard.organizer.employeeId, "groups", 120);

    if (blocked) return blocked;

    const employeeId = parseIdParam((await params).id);

    if (employeeId === null) return jsonError(400, "Invalid employee id.");

    await unassignEmployee(employeeId, guard.organizer.employeeId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof GroupError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
