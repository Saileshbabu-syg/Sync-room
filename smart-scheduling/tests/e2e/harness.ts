import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { encode } from "@auth/core/jwt";

import { startSmtpSink } from "../helpers/smtp-sink";

// Boots the PRODUCTION build (`next start`) against the isolated test database
// and a local SMTP sink, and talks to it over real HTTP with real Auth.js
// session cookies (minted with the throw-away test secret). Nothing is mocked
// inside the app: authentication, authorization, validation and the database
// all run for real.

const root = path.resolve(__dirname, "../..");
const COOKIE = "authjs.session-token";
const SECRET = process.env.AUTH_SECRET!;

export type Identity = { email: string; name?: string };

export async function mintSession(
  user: Identity,
  options: { secret?: string; salt?: string; maxAge?: number } = {}
) {
  return encode({
    token: { name: user.name ?? user.email, email: user.email, sub: user.email },
    secret: options.secret ?? SECRET,
    salt: options.salt ?? COOKIE,
    maxAge: options.maxAge ?? 3600,
  });
}

export type CallOptions = {
  as?: Identity;
  cookie?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
};

// `relaxedRateLimits` (default) lifts the per-user request caps so that
// functional tests are not throttled; the dedicated rate-limit test starts its
// own server with the real defaults.
export async function startApp(
  port: number,
  { relaxedRateLimits = true }: { relaxedRateLimits?: boolean } = {}
) {
  if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) {
    throw new Error(
      "No production build found. Run the build with the test environment first: " +
        "npm run build:test"
    );
  }

  const sink = await startSmtpSink();
  const baseUrl = `http://localhost:${port}`;

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        NEXTAUTH_URL: baseUrl,
        AUTH_URL: baseUrl,
        AUTH_TRUST_HOST: "true",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(sink.port),
        REMINDER_CRON_ENABLED: "false",
        ...(relaxedRateLimits
          ? {
              RATE_LIMIT_BOOKING_PER_MINUTE: "10000",
              RATE_LIMIT_RECURRING_PER_MINUTE: "10000",
              RATE_LIMIT_EDIT_PER_MINUTE: "10000",
              RATE_LIMIT_CANCEL_PER_MINUTE: "10000",
              RATE_LIMIT_SUGGESTIONS_PER_MINUTE: "10000",
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));

  const deadline = Date.now() + 90_000;

  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/login`, { redirect: "manual" });

      if (res.status === 200) break;
    } catch {
      // not up yet
    }

    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      await sink.close();
      throw new Error(`App failed to start.\n${log.slice(-2000)}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  async function call(method: string, urlPath: string, opts: CallOptions = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };

    if (opts.as) headers.cookie = `${COOKIE}=${await mintSession(opts.as)}`;
    if (opts.cookie) headers.cookie = opts.cookie;

    let body: string | undefined;

    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] ??= "application/json";
    }

    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body,
      redirect: "manual",
    });

    const text = await res.text();
    let json: Record<string, unknown> | undefined;

    try {
      json = JSON.parse(text);
    } catch {
      // not JSON (page)
    }

    return {
      status: res.status,
      text,
      json,
      headers: res.headers,
      location: res.headers.get("location"),
    };
  }

  return {
    baseUrl,
    sink,
    call,
    log: () => log,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
      await sink.close();
    },
  };
}

export type App = Awaited<ReturnType<typeof startApp>>;

export const isRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);
