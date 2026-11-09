import { NextResponse } from "next/server";
import { z } from "zod";

import { guardMutation, jsonError, rateLimit, readJson } from "@/lib/api";
import { MAX_INT4 } from "@/lib/constants";
import { requireAdmin } from "@/lib/permissions";
import { requeueFailedDelivery } from "@/lib/services/delivery-admin.service";

const bodySchema = z.object({
  kind: z.enum(["notification", "reminder"]),
  id: z.number().int().min(1).max(MAX_INT4),
});

// Puts one FAILED e-mail back in the queue (fresh attempts). Admin role only.
export async function POST(request: Request) {
  try {
    const guard = await requireAdmin();

    if (!guard.ok) return guard.response;

    const blocked =
      guardMutation(request) ??
      rateLimit(guard.organizer.employeeId, "failed-emails", 30);

    if (blocked) return blocked;

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = bodySchema.safeParse(body.data);

    if (!parsed.success) return jsonError(400, "Invalid request.");

    const requeued = await requeueFailedDelivery(
      parsed.data.kind,
      parsed.data.id,
      guard.organizer.employeeId
    );

    if (!requeued) {
      return jsonError(404, "No failed e-mail with that id.");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
