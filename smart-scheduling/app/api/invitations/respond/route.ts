import { NextResponse } from "next/server";
import { z } from "zod";

import { guardMutation, jsonError, readJson } from "@/lib/api";
import { isValidInvitationToken } from "@/lib/invitation-token";
import { checkRateLimit } from "@/lib/rate-limit";
import { respondToInvitation } from "@/lib/services/invitation.service";

const bodySchema = z.object({
  meetingId: z.number().int().positive(),
  employeeId: z.number().int().positive(),
  token: z.string().length(64),
  action: z.enum(["accept", "decline"]),
});

// Public on purpose: participants answer from their e-mail without signing in.
// What authorizes the request is the signed token for exactly this meeting and
// employee, and the database makes each invitation answerable only once.
export async function POST(request: Request) {
  try {
    const blocked = guardMutation(request);

    if (blocked) return blocked;

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const limit = checkRateLimit(`invite:${ip}`, 30, 60_000);

    if (!limit.allowed) {
      return jsonError(429, "Too many attempts. Please try again shortly.");
    }

    const body = await readJson(request);

    if (!body.ok) return body.response;

    const parsed = bodySchema.safeParse(body.data);

    if (!parsed.success) return jsonError(400, "Invalid invitation link.");

    const { meetingId, employeeId, token, action } = parsed.data;

    // Same answer whether the pair exists or not, so links cannot be probed.
    if (!isValidInvitationToken(meetingId, employeeId, token)) {
      return jsonError(403, "This invitation link is not valid.");
    }

    const result = await respondToInvitation(meetingId, employeeId, action);

    if (result.status === "not-found") {
      return jsonError(403, "This invitation link is not valid.");
    }

    if (result.status === "closed") {
      return jsonError(410, result.reason);
    }

    if (result.status === "already") {
      return NextResponse.json(
        {
          success: false,
          message: "You have already responded to this invitation.",
          response: result.response,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ success: true, response: result.response });
  } catch (error) {
    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
