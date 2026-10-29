import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { NextRequest } from "next/server";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Pins how the INSTALLED Auth.js resolves its environment, so an upgrade that
// changes it is noticed. Uses the real NextAuth() handler with dummy Google
// credentials; nothing leaves the process.

const KEYS = [
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "AUTH_URL",
  "NEXTAUTH_URL",
  "AUTH_TRUST_HOST",
  "VERCEL",
  "CF_PAGES",
  "NODE_ENV",
] as const;

const saved: Record<string, string | undefined> = {};
const SECRET = "unit-test-secret-0123456789abcdef0123456789abcdef";

async function csrfStatus(url = "http://localhost:3000/api/auth/csrf") {
  const { handlers } = NextAuth({
    providers: [Google({ clientId: "dummy", clientSecret: "dummy" })],
  });

  const res = await handlers.GET(new NextRequest(url));

  return res.status;
}

describe("Auth.js environment resolution (installed version)", () => {
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    Object.assign(process.env, { NODE_ENV: "production" });
    mock.method(console, "error", () => {});
  });

  afterEach(() => {
    mock.restoreAll();

    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else (process.env as Record<string, string | undefined>)[k] = saved[k];
    }
  });

  it("production with AUTH_SECRET + AUTH_URL works", async () => {
    process.env.AUTH_SECRET = SECRET;
    process.env.AUTH_URL = "http://localhost:3000";

    assert.equal(await csrfStatus(), 200);
  });

  it("NEXTAUTH_SECRET is still accepted as the secret", async () => {
    process.env.NEXTAUTH_SECRET = SECRET;
    process.env.AUTH_URL = "http://localhost:3000";

    assert.equal(await csrfStatus(), 200);
  });

  it("production without a secret is rejected", async () => {
    process.env.AUTH_URL = "http://localhost:3000";

    assert.notEqual(await csrfStatus(), 200);
  });

  it("production with only NEXTAUTH_URL does NOT trust the host", async () => {
    process.env.AUTH_SECRET = SECRET;
    process.env.NEXTAUTH_URL = "http://localhost:3000";

    assert.notEqual(await csrfStatus(), 200);
  });

  it("AUTH_URL pins the origin: a request for another host is rewritten to it", async () => {
    process.env.AUTH_SECRET = SECRET;
    process.env.AUTH_URL = "https://rooms.example.com";

    const { handlers } = NextAuth({
      providers: [Google({ clientId: "dummy", clientSecret: "dummy" })],
    });

    const res = await handlers.GET(
      new NextRequest("http://evil.example/api/auth/providers")
    );
    const body = (await res.json()) as {
      google: { callbackUrl: string; signinUrl: string };
    };

    assert.equal(
      body.google.callbackUrl,
      "https://rooms.example.com/api/auth/callback/google"
    );
  });
});
