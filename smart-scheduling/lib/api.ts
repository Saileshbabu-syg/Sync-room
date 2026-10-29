// Shared helpers for API route handlers: error shape, body/param parsing,
// cross-site request guard and rate limiting.

import { NextResponse } from "next/server";

import { MAX_INT4 } from "@/lib/constants";
import { checkRateLimit } from "@/lib/rate-limit";

export function jsonError(
  status: number,
  message: string,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json({ success: false, message, ...extra }, { status });
}

export async function readJson(
  req: Request
): Promise<
  { ok: true; data: unknown } | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, data: await req.json() };
  } catch {
    return {
      ok: false,
      response: jsonError(400, "Request body must be valid JSON."),
    };
  }
}

// Path ids must be plain positive integers that fit a Postgres `integer`;
// "1.5", "abc", "-1" and 99999999999 are all rejected.
export function parseIdParam(value: string | undefined | null): number | null {
  if (!value || !/^\d{1,10}$/.test(value)) return null;

  const id = Number(value);

  return id >= 1 && id <= MAX_INT4 ? id : null;
}

// Defence in depth on top of SameSite=Lax session cookies: refuse mutating
// requests that the browser marks as cross-site, whose Origin is not this
// host, or (when a JSON body is expected) that are not application/json —
// which also rules out "simple" cross-site form posts.
export function guardMutation(
  req: Request,
  { expectJson = true }: { expectJson?: boolean } = {}
): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");

  if (site && site !== "same-origin" && site !== "none") {
    return jsonError(403, "Cross-site requests are not allowed.");
  }

  const origin = req.headers.get("origin");

  if (origin) {
    const host = (
      req.headers.get("x-forwarded-host") ?? req.headers.get("host")
    )
      ?.split(",")[0]
      .trim();

    let originHost: string;

    try {
      originHost = new URL(origin).host;
    } catch {
      return jsonError(403, "Cross-site requests are not allowed.");
    }

    if (originHost !== host) {
      return jsonError(403, "Cross-site requests are not allowed.");
    }
  }

  if (expectJson) {
    const contentType = req.headers.get("content-type") ?? "";

    if (!/^application\/json\b/i.test(contentType)) {
      return jsonError(415, "Content-Type must be application/json.");
    }
  }

  return null;
}

// Returns a 429 response when `userId` exceeded `limit` calls to `bucket`
// within `windowMs`, otherwise null. Operators can tune a bucket with
// RATE_LIMIT_<BUCKET>_PER_MINUTE (e.g. RATE_LIMIT_BOOKING_PER_MINUTE=40).
export function rateLimit(
  userId: number,
  bucket: string,
  limit: number,
  windowMs = 60_000
): NextResponse | null {
  const configured = Number(
    process.env[`RATE_LIMIT_${bucket.toUpperCase()}_PER_MINUTE`]
  );

  const effective =
    Number.isInteger(configured) && configured > 0 ? configured : limit;

  const result = checkRateLimit(`${bucket}:${userId}`, effective, windowMs);

  if (result.allowed) return null;

  const response = jsonError(
    429,
    "Too many requests. Please slow down and try again shortly."
  );
  response.headers.set("Retry-After", String(result.retryAfterSeconds));

  return response;
}

// Drizzle wraps driver errors; the Postgres SQLSTATE sits on `error.cause`.
export function dbErrorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;

    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_UNIQUE_VIOLATION = "23505";
