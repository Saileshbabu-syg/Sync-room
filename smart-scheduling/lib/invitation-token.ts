import { createHmac, timingSafeEqual } from "node:crypto";

// Invitation links carry a token that proves the link was issued by this
// application for ONE (meeting, employee) pair. It is an HMAC of those two ids
// under the application secret, so nothing has to be stored, it cannot be
// forged or moved to another meeting or person, and the same link is produced
// again if the e-mail is re-sent.
//
// The token only identifies the invitation. Whether a response is still
// allowed (not answered yet, meeting still on) is decided by the database in
// invitation.service, which is also what makes every link single-use.

function secret(): string {
  const value = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

  if (value) return value;

  // The app refuses to start in production without one (auth-config); this
  // fallback only keeps local development and tests working.
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is not set.");
  }

  return "development-only-invitation-secret";
}

export function invitationToken(meetingId: number, employeeId: number) {
  return createHmac("sha256", secret())
    .update(`invite:${meetingId}:${employeeId}`)
    .digest("hex");
}

export function isValidInvitationToken(
  meetingId: number,
  employeeId: number,
  token: string
) {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;

  return timingSafeEqual(
    Buffer.from(token, "hex"),
    Buffer.from(invitationToken(meetingId, employeeId), "hex")
  );
}

// Public origin used in e-mailed links.
export function appBaseUrl() {
  return (
    process.env.AUTH_URL ??
    process.env.NEXTAUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/+$/, "");
}

// Link to the confirmation page for one answer. The page asks for a click
// before anything is saved, so mail scanners that open links cannot answer.
export function invitationLink(
  meetingId: number,
  employeeId: number,
  action: "accept" | "decline"
) {
  const params = new URLSearchParams({
    m: String(meetingId),
    e: String(employeeId),
    t: invitationToken(meetingId, employeeId),
    a: action,
  });

  return `${appBaseUrl()}/invite?${params}`;
}
