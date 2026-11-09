import { NextResponse } from "next/server";

import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import { requireGroupManagement } from "@/lib/permissions";
import {
  getAppBookingSettings,
  updateAppBookingSettings,
} from "@/lib/services/booking-settings.service";
import { GroupError } from "@/lib/services/group.service";
import { appBookingSettingsSchema } from "@/lib/validations/booking-settings.validator";

// Application-wide booking policies. For people who may manage groups (the
// Admin role, or a group that grants group.manage), for reading and for
// changing; the service checks again from the database.
export async function GET() {
  const guard = await requireGroupManagement();

  if (!guard.ok) return guard.response;

  return NextResponse.json({ success: true, settings: await getAppBookingSettings() });
}

export async function PUT(request: Request) {
  try {
    const guard = await requireGroupManagement();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "booking-settings", 30);

    if (blocked) return blocked;

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = appBookingSettingsSchema.safeParse(body.data);

    if (!parsed.success) {
      return jsonError(400, parsed.error.issues[0]?.message ?? "Validation failed");
    }

    const settings = await updateAppBookingSettings(
      parsed.data,
      guard.organizer.employeeId
    );

    return NextResponse.json({ success: true, settings });
  } catch (error) {
    if (error instanceof GroupError) return jsonError(error.status, error.message);

    console.error(error);

    return jsonError(500, "Could not save the booking policies.");
  }
}
