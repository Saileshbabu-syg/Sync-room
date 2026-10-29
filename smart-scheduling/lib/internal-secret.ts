import { timingSafeEqual } from "crypto";

// Shared secret for server-to-server calls to /api/notifications/email.
//
// The application itself no longer calls that endpoint (mail is sent in
// process, after the booking transaction commits), so it is disabled unless an
// operator explicitly configures INTERNAL_API_SECRET. There is deliberately no
// random per-process fallback: a secret that differs between instances would
// make the endpoint fail in confusing ways.
export const INTERNAL_API_SECRET: string | undefined =
  process.env.INTERNAL_API_SECRET || undefined;

export function isValidInternalSecret(candidate: string | null): boolean {
  if (!INTERNAL_API_SECRET || !candidate) return false;

  const expected = Buffer.from(INTERNAL_API_SECRET);
  const actual = Buffer.from(candidate);

  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}
