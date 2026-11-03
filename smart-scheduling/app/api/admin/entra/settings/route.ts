import { NextResponse } from "next/server";

import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import { requireGroupManagement } from "@/lib/permissions";
import {
  getEntraSettings,
  updateEntraSettings,
} from "@/lib/services/entra-settings.service";
import { GroupError } from "@/lib/services/group.service";
import { entraSettingsSchema } from "@/lib/validations/group.validator";

export async function GET() {
  const guard = await requireGroupManagement();

  if (!guard.ok) return guard.response;

  return NextResponse.json({ success: true, settings: await getEntraSettings() });
}

export async function PUT(request: Request) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "entra-settings", 30);

    if (blocked) return blocked;

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = entraSettingsSchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(400, parsed.error.issues[0]?.message ?? "Validation failed");
    }

    await updateEntraSettings(parsed.data, guard.organizer.employeeId);

    return NextResponse.json({ success: true, settings: await getEntraSettings() });
  } catch (error) {
    if (error instanceof GroupError) return jsonError(error.status, error.message);

    console.error(error);

    return jsonError(500, "Could not save the settings.");
  }
}
