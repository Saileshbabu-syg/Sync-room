import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { onlineInviteMaxWaitMinutes } from "@/lib/delivery-policy";
import { onlineBackoffMs } from "@/lib/services/online-meeting.service";
import {
  checkTeamsHealth,
  clientCredentialsTokenProvider,
  createGraphTeamsProvider,
  isValidJoinUrl,
  parseRetryAfter,
  TeamsError,
} from "@/lib/services/teams-meeting.service";

// Phase 5: Graph throttling and error classes, join URL allowlist, backoff,
// the e-mail wait limit, and the health check.

const slot = { title: "Planning", meetingDate: "2030-01-15", startTime: "10:00:00", endTime: "11:00:00", roomName: "Alpha" };

function fakeFetch(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  }) as typeof fetch;

  return { doFetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const provider = (doFetch: typeof fetch) =>
  createGraphTeamsProvider({ organizerEmail: "rooms@contoso.test", tokenProvider: async () => "TOKEN", doFetch });

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  assert.ok(error instanceof TeamsError, String(error));
  return error;
}

describe("Graph errors: what is retried", () => {
  it("parses Retry-After in seconds and as an HTTP date", () => {
    assert.equal(parseRetryAfter("120"), 120_000);
    assert.equal(parseRetryAfter(new Date(10_000 + 30_000).toUTCString(), 10_000), 30_000);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("soon"), undefined);
  });

  it("429 is retryable and carries Retry-After", async () => {
    const { doFetch } = fakeFetch(json({}, 429, { "Retry-After": "45" }));
    const error = await failureOf(provider(doFetch).createEvent(slot, "t"));

    assert.deepEqual([error.code, error.retryable, error.retryAfterMs], ["THROTTLED", true, 45_000]);
  });

  for (const status of [500, 502, 503, 504]) {
    it(`HTTP ${status} is retryable`, async () => {
      const { doFetch } = fakeFetch(json({}, status));
      const error = await failureOf(provider(doFetch).updateEvent("E", slot));

      assert.equal(error.retryable, true);
    });
  }

  for (const [status, code] of [[400, "GRAPH"], [401, "AUTH"], [403, "PERMISSION"], [409, "GRAPH"]] as const) {
    it(`HTTP ${status} is permanent (${code})`, async () => {
      const { doFetch } = fakeFetch(json({ error: { message: "tenant-secret rooms@contoso.test" } }, status));
      const error = await failureOf(provider(doFetch).createEvent(slot, "t"));

      assert.deepEqual([error.code, error.retryable], [code, false]);
      assert.doesNotMatch(error.message, /tenant-secret|contoso/);
    });
  }

  it("a network failure or timeout is retryable", async () => {
    const reset = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const timeout = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch;

    assert.equal((await failureOf(provider(reset).createEvent(slot, "t"))).retryable, true);
    assert.equal((await failureOf(provider(timeout).createEvent(slot, "t"))).code, "TIMEOUT");
  });

  it("sign-in: a Microsoft outage is retried, a refused credential is not; nothing secret leaks", async () => {
    const env = { TEAMS_TENANT_ID: "tenant", TEAMS_CLIENT_ID: "client", TEAMS_CLIENT_SECRET: "s3cr3t-value" };

    const outage = await failureOf(clientCredentialsTokenProvider(env, fakeFetch(json({}, 503)).doFetch)());
    assert.deepEqual([outage.code, outage.retryable], ["AUTH", true]);

    const refused = await failureOf(
      clientCredentialsTokenProvider(env, fakeFetch(json({ error_description: "AADSTS7000222: secret s3cr3t-value expired" }, 401)).doFetch)()
    );
    assert.deepEqual([refused.code, refused.retryable], ["AUTH", false]);
    assert.doesNotMatch(refused.message, /s3cr3t-value|AADSTS/);
  });

  it("an event already deleted counts as deleted (404 / 410)", async () => {
    await provider(fakeFetch(new Response(null, { status: 404 })).doFetch).deleteEvent("E");
    await provider(fakeFetch(new Response(null, { status: 410 })).doFetch).deleteEvent("E");
  });

  it("the event carries the room as its location", async () => {
    const { doFetch, calls } = fakeFetch(json({}, 200));

    await provider(doFetch).updateEvent("E", slot);

    assert.deepEqual(JSON.parse(String(calls[0].init.body)).location, { displayName: "Alpha" });
  });
});

describe("backoff", () => {
  it("respects Retry-After, otherwise grows exponentially with jitter, capped", () => {
    assert.equal(onlineBackoffMs(1, 45_000), 45_000);
    assert.equal(onlineBackoffMs(3, 0), 1000, "never zero");

    assert.equal(onlineBackoffMs(1, undefined, () => 0.5), 30_000);
    assert.equal(onlineBackoffMs(2, undefined, () => 0.5), 60_000);
    assert.equal(onlineBackoffMs(3, undefined, () => 0.5), 120_000);
    assert.equal(onlineBackoffMs(20, undefined, () => 0.5), 30 * 60_000);

    assert.equal(onlineBackoffMs(1, undefined, () => 0), 24_000, "-20%");
    assert.equal(onlineBackoffMs(1, undefined, () => 1), 36_000, "+20%");
  });

  it("the e-mail wait limit is configurable, 15 minutes by default", () => {
    assert.equal(onlineInviteMaxWaitMinutes({}), 15);
    assert.equal(onlineInviteMaxWaitMinutes({ ONLINE_INVITE_MAX_WAIT_MINUTES: "5" }), 5);
    assert.equal(onlineInviteMaxWaitMinutes({ ONLINE_INVITE_MAX_WAIT_MINUTES: "0" }), 0);
    assert.equal(onlineInviteMaxWaitMinutes({ ONLINE_INVITE_MAX_WAIT_MINUTES: "-1" }), 15);
    assert.equal(onlineInviteMaxWaitMinutes({ ONLINE_INVITE_MAX_WAIT_MINUTES: "soon" }), 15);
  });
});

describe("join URL allowlist", () => {
  it("accepts the Teams hosts Graph returns", () => {
    for (const url of [
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x",
      "https://teams.microsoft.com/meet/123456789?p=abc",
      "https://teams.live.com/meet/9876",
      "https://gov.teams.microsoft.us/l/meetup-join/x",
      "https://dod.teams.microsoft.us/l/meetup-join/x",
      "https://TEAMS.MICROSOFT.COM/l/meetup-join/x",
    ]) {
      assert.equal(isValidJoinUrl(url), true, url);
    }
  });

  it("rejects lookalikes, other schemes, ports, credentials and malformed values", () => {
    for (const url of [
      "https://teams.evil.example/l/meetup-join/x",
      "https://teams.microsoft.com.evil.example/x",
      "https://evilteams.microsoft.com/x",
      "https://microsoft.com/teams",
      "https://evil.example/teams.microsoft.com",
      "http://teams.microsoft.com/l/x",
      "javascript:alert(1)",
      "https://teams.microsoft.com:8443/x",
      "https://user:pass@teams.microsoft.com/x",
      "https://teams.microsoft.com@evil.example/x",
      "not a url",
      "",
      `https://teams.microsoft.com/${"x".repeat(2100)}`,
    ]) {
      assert.equal(isValidJoinUrl(url), false, url);
    }

    assert.equal(isValidJoinUrl(undefined), false);
    assert.equal(isValidJoinUrl(42), false);
  });
});

describe("health check", () => {
  const env = {
    TEAMS_TENANT_ID: "tenant",
    TEAMS_CLIENT_ID: "client",
    TEAMS_CLIENT_SECRET: "s3cr3t-value",
    TEAMS_ORGANIZER_EMAIL: "rooms@contoso.test",
  };

  // A fake app-only token whose payload grants `roles`.
  const token = (roles: string[]) =>
    ["h", Buffer.from(JSON.stringify({ roles })).toString("base64url"), "sig"].join(".");

  it("reports a missing configuration and skips the rest", async () => {
    const health = await checkTeamsHealth({});

    assert.equal(health.configuration.ok, false);
    assert.ok(health.configuration.problems.length > 0);
    assert.equal(health.authentication.ok, null);
    assert.equal(health.mailbox.ok, null);
  });

  it("checks sign-in, the granted permission and the mailbox; never returns secrets or tokens", async () => {
    const t = token(["Calendars.ReadWrite"]);
    const { doFetch, calls } = fakeFetch(json({ access_token: t, expires_in: 3600 }), json({ id: "cal" }));

    const health = await checkTeamsHealth(env, doFetch);

    assert.deepEqual(
      [health.configuration.ok, health.authentication.ok, health.permissions.ok, health.mailbox.ok],
      [true, true, true, true]
    );
    assert.equal(health.mailbox.organizer, "rooms@contoso.test");
    assert.ok(calls[1].url.endsWith("/users/rooms%40contoso.test/calendar?$select=id"));
    assert.equal(calls[1].init.method ?? "GET", "GET", "read-only: nothing is created");

    const text = JSON.stringify(health);
    assert.doesNotMatch(text, /s3cr3t-value/);
    assert.ok(!text.includes(t), "the token is never returned");
  });

  it("names a missing permission and a refused mailbox separately", async () => {
    const { doFetch } = fakeFetch(json({ access_token: token(["User.Read.All"]) }), json({}, 403));

    const health = await checkTeamsHealth(env, doFetch);

    assert.equal(health.authentication.ok, true);
    assert.equal(health.permissions.ok, false);
    assert.match(health.permissions.message, /Calendars.ReadWrite/);
    assert.equal(health.mailbox.ok, false);
    assert.match(health.mailbox.message, /application access policy/);
  });

  it("reports a failed sign-in without the reason Microsoft gave", async () => {
    const { doFetch } = fakeFetch(json({ error_description: "secret expired s3cr3t-value" }, 401));

    const health = await checkTeamsHealth(env, doFetch);

    assert.equal(health.authentication.ok, false);
    assert.equal(health.mailbox.ok, null);
    assert.doesNotMatch(JSON.stringify(health), /s3cr3t-value/);
  });
});
