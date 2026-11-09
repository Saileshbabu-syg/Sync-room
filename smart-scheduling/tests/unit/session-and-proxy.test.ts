import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { NextRequest } from "next/server";
import { decode, encode } from "next-auth/jwt";

import { clientIp } from "@/lib/api";
import { capSessionAge, SESSION_MAX_AGE_SECONDS } from "@/lib/auth-config";

// S-04 (session lifetime) and S-07 (trusted-proxy client IP).

const HOUR = 3600;
const COOKIE = "authjs.session-token";

describe("session lifetime (S-04)", () => {
  it("is 12 hours", () => {
    assert.equal(SESSION_MAX_AGE_SECONDS, 12 * HOUR);
  });

  it("stamps the sign-in time on a new session", () => {
    const token = capSessionAge({ email: "a@b.test", authTime: 1 }, true, 1_000_000);

    assert.equal(token?.authTime, 1_000_000);
  });

  it("keeps a session younger than 12 hours, whatever its idle refreshes did to iat", () => {
    const now = 1_000_000;
    const token = capSessionAge({ authTime: now - 11 * HOUR, iat: now - 60 }, false, now);

    assert.equal(token?.authTime, now - 11 * HOUR);
  });

  it("ends a session 12 hours after sign-in even if it was used all along", () => {
    const now = 1_000_000;

    assert.equal(capSessionAge({ authTime: now - 12 * HOUR - 1, iat: now - 60 }, false, now), null);
  });

  it("a token issued before the stamp existed starts counting from its iat", () => {
    const now = 1_000_000;

    assert.equal(capSessionAge({ iat: now - 5 * HOUR }, false, now)?.authTime, now - 5 * HOUR);
  });
});

describe("the installed Auth.js applies it (real auth.ts handlers)", () => {
  async function session(token: Record<string, unknown>) {
    const { handlers } = await import("@/auth");
    const cookie = await encode({
      token,
      secret: process.env.AUTH_SECRET!,
      salt: COOKIE,
      maxAge: 30 * 24 * HOUR,
    });

    const res = await handlers.GET(
      new NextRequest("http://localhost:3000/api/auth/session", {
        headers: { cookie: `${COOKIE}=${cookie}` },
      })
    );

    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));

    return { body: await res.json(), setCookie };
  }

  const expiresAt = (setCookie: string) => {
    const match = /Expires=([^;]+)/i.exec(setCookie);

    return match ? Date.parse(match[1]) / 1000 : NaN;
  };

  it("re-issues the cookie and the token for 12 hours, not 30 days", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { body, setCookie } = await session({ email: "a@b.test", authTime: now - 60 });

    assert.ok(setCookie, "a refreshed session cookie is set");
    assert.ok(Math.abs(expiresAt(setCookie) - (now + 12 * HOUR)) < 120, setCookie);
    assert.ok(Math.abs(Date.parse(body.expires) / 1000 - (now + 12 * HOUR)) < 120);

    const value = /^[^=]+=([^;]+)/.exec(setCookie)![1];
    const payload = await decode({ token: value, secret: process.env.AUTH_SECRET!, salt: COOKIE });

    assert.ok(Math.abs((payload!.exp as number) - (now + 12 * HOUR)) < 120);
    assert.equal(payload!.authTime, now - 60);
  });

  it("clears a session signed in more than 12 hours ago", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { body, setCookie } = await session({ email: "a@b.test", authTime: now - 13 * HOUR });

    assert.equal(body, null);
    assert.ok(setCookie && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(setCookie), setCookie);
  });
});

describe("client IP for anonymous rate limits (S-07)", () => {
  const saved = process.env.TRUST_PROXY_HEADERS;

  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = saved;
  });

  const req = (headers: Record<string, string>) =>
    new Request("http://localhost/api/invitations/respond", { headers });

  it("ignores X-Forwarded-For unless a trusted proxy is configured", () => {
    delete process.env.TRUST_PROXY_HEADERS;

    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.9" })), null);
    assert.equal(clientIp(req({ "x-real-ip": "203.0.113.9" })), null);

    process.env.TRUST_PROXY_HEADERS = "1";
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.9" })), null, "only the exact value true");
  });

  it("behind a trusted proxy, uses the hop the proxy appended, not what the client claimed", () => {
    process.env.TRUST_PROXY_HEADERS = "true";

    // The client sent "1.2.3.4"; the proxy appended the real address.
    assert.equal(clientIp(req({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" })), "198.51.100.7");
    assert.equal(clientIp(req({ "x-forwarded-for": "198.51.100.7" })), "198.51.100.7");
    assert.equal(clientIp(req({ "x-real-ip": "198.51.100.8" })), "198.51.100.8");
    assert.equal(clientIp(req({})), null);
  });
});
