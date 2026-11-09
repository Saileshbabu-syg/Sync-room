import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderInvitationEmail, renderMeetingEmail } from "@/lib/services/email.service";
import {
  clientCredentialsTokenProvider,
  createGraphTeamsProvider,
  isValidJoinUrl,
  teamsConfigProblems,
  TeamsError,
} from "@/lib/services/teams-meeting.service";

const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x";

const slot = {
  title: "Planning",
  meetingDate: "2030-01-15",
  startTime: "10:00:00",
  endTime: "11:00:00",
};

type Call = { url: string; init: RequestInit };

// A scripted fetch: answers with the queued responses in order and records
// every call.
function fakeFetch(...answers: Response[]) {
  const calls: Call[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  }) as typeof fetch;

  return { doFetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const provider = (doFetch: typeof fetch) =>
  createGraphTeamsProvider({
    organizerEmail: "rooms@contoso.test",
    tokenProvider: async () => "TOKEN",
    doFetch,
  });

describe("Teams configuration", () => {
  it("names every missing variable and never a value", () => {
    const problems = teamsConfigProblems({});

    assert.equal(problems.length, 4);
    assert.ok(problems.every((p) => /TEAMS_/.test(p)));
  });

  it("accepts a complete configuration", () => {
    assert.deepEqual(
      teamsConfigProblems({
        TEAMS_TENANT_ID: "t",
        TEAMS_CLIENT_ID: "c",
        TEAMS_CLIENT_SECRET: "s",
        TEAMS_ORGANIZER_EMAIL: "rooms@contoso.test",
      }),
      []
    );
  });

  it("rejects a malformed organizer address", () => {
    assert.equal(
      teamsConfigProblems({
        TEAMS_TENANT_ID: "t",
        TEAMS_CLIENT_ID: "c",
        TEAMS_CLIENT_SECRET: "s",
        TEAMS_ORGANIZER_EMAIL: "not-an-email",
      }).length,
      1
    );
  });
});

describe("join URL validation", () => {
  it("accepts https Teams links only", () => {
    assert.equal(isValidJoinUrl(JOIN), true);
    assert.equal(isValidJoinUrl("http://teams.microsoft.com/x"), false);
    assert.equal(isValidJoinUrl("https://evil.example/teams.microsoft.com"), false);
    assert.equal(isValidJoinUrl("javascript:alert(1)"), false);
    assert.equal(isValidJoinUrl(""), false);
    assert.equal(isValidJoinUrl(undefined), false);
  });
});

describe("Graph event creation", () => {
  it("creates an organizer-only Teams event and returns the join URL", async () => {
    const { doFetch, calls } = fakeFetch(
      json({ id: "EVT1", onlineMeeting: { joinUrl: JOIN } }, 201)
    );

    const created = await provider(doFetch).createEvent(slot, "sched-meeting-7");

    assert.deepEqual(created, { eventId: "EVT1", joinUrl: JOIN });

    const [call] = calls;
    const body = JSON.parse(String(call.init.body));

    assert.equal(call.init.method, "POST");
    assert.equal(
      call.url,
      "https://graph.microsoft.com/v1.0/users/rooms%40contoso.test/events"
    );
    assert.equal(
      (call.init.headers as Record<string, string>).Authorization,
      "Bearer TOKEN"
    );
    assert.equal(body.isOnlineMeeting, true);
    assert.equal(body.onlineMeetingProvider, "teamsForBusiness");
    assert.equal(body.subject, "Planning");
    assert.equal(body.transactionId, "sched-meeting-7");
    assert.deepEqual(body.start, {
      dateTime: "2030-01-15T10:00:00",
      timeZone: "Asia/Kolkata",
    });
    assert.deepEqual(body.end, {
      dateTime: "2030-01-15T11:00:00",
      timeZone: "Asia/Kolkata",
    });
    // Organizer only: no attendees, so Outlook sends no second invitation.
    assert.equal("attendees" in body, false);
  });

  it("accepts HH:MM times", async () => {
    const { doFetch, calls } = fakeFetch(
      json({ id: "E", onlineMeeting: { joinUrl: JOIN } }, 201)
    );

    await provider(doFetch).createEvent(
      { ...slot, startTime: "09:30", endTime: "10:15" },
      "t"
    );

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.start.dateTime, "2030-01-15T09:30:00");
    assert.equal(body.end.dateTime, "2030-01-15T10:15:00");
  });

  it("removes the event and fails when Graph returns no join URL", async () => {
    const { doFetch, calls } = fakeFetch(
      json({ id: "EVT2", onlineMeeting: null }, 201),
      new Response(null, { status: 204 })
    );

    await assert.rejects(
      provider(doFetch).createEvent(slot, "t"),
      (e: TeamsError) => e.code === "NO_JOIN_URL"
    );

    assert.equal(calls[1].init.method, "DELETE");
    assert.match(calls[1].url, /\/events\/EVT2$/);
  });

  it("rejects a join URL that is not a Teams link", async () => {
    const { doFetch } = fakeFetch(
      json({ id: "E", onlineMeeting: { joinUrl: "https://evil.example/x" } }, 201),
      new Response(null, { status: 204 })
    );

    await assert.rejects(
      provider(doFetch).createEvent(slot, "t"),
      (e: TeamsError) => e.code === "NO_JOIN_URL"
    );
  });

  for (const [status, code] of [
    [401, "AUTH"],
    [403, "PERMISSION"],
    [404, "NOT_FOUND"],
    [429, "THROTTLED"],
    [500, "GRAPH"],
  ] as const) {
    it(`maps HTTP ${status} to ${code} without echoing the response body`, async () => {
      const { doFetch } = fakeFetch(
        json({ error: { code: "X", message: "tenant secret-tenant-id mailbox rooms@contoso.test" } }, status)
      );

      await assert.rejects(provider(doFetch).createEvent(slot, "t"), (e: TeamsError) => {
        assert.equal(e.code, code);
        assert.doesNotMatch(e.message, /secret-tenant-id|contoso/);
        return true;
      });
    });
  }

  it("reports a network failure as a TeamsError", async () => {
    const doFetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;

    await assert.rejects(
      provider(doFetch).createEvent(slot, "t"),
      (e: TeamsError) => e instanceof TeamsError && e.code === "GRAPH"
    );
  });
});

describe("Graph event update and delete", () => {
  it("patches subject, start and end", async () => {
    const { doFetch, calls } = fakeFetch(json({}, 200));

    await provider(doFetch).updateEvent("EVT1", { ...slot, title: "Moved" });

    assert.equal(calls[0].init.method, "PATCH");
    assert.match(calls[0].url, /\/events\/EVT1$/);

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.subject, "Moved");
    assert.equal("isOnlineMeeting" in body, false);
  });

  it("treats an already deleted event as deleted (idempotent)", async () => {
    for (const status of [204, 404, 410]) {
      const { doFetch } = fakeFetch(new Response(null, { status }));

      await provider(doFetch).deleteEvent("EVT1");
    }
  });

  it("fails a delete on a real error", async () => {
    const { doFetch } = fakeFetch(new Response(null, { status: 503 }));

    await assert.rejects(provider(doFetch).deleteEvent("EVT1"), TeamsError);
  });
});

describe("app-only token", () => {
  const env = {
    TEAMS_TENANT_ID: "tenant-1",
    TEAMS_CLIENT_ID: "client-1",
    TEAMS_CLIENT_SECRET: "shh",
  };

  it("requests a client-credentials token and caches it", async () => {
    const { doFetch, calls } = fakeFetch(
      json({ access_token: "A", expires_in: 3600 })
    );
    const token = clientCredentialsTokenProvider(env, doFetch);

    assert.equal(await token(), "A");
    assert.equal(await token(), "A");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /login\.microsoftonline\.com\/tenant-1\//);

    const form = String(calls[0].init.body);
    assert.match(form, /grant_type=client_credentials/);
    assert.match(form, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
  });

  it("fails safely when sign-in is refused", async () => {
    const { doFetch } = fakeFetch(json({ error: "invalid_client", secret: "shh" }, 401));

    await assert.rejects(
      clientCredentialsTokenProvider(env, doFetch)(),
      (e: TeamsError) => e.code === "AUTH" && !/shh/.test(e.message)
    );
  });
});

describe("e-mail content", () => {
  const base = {
    title: "Planning",
    meetingDate: "2030-01-15",
    startTime: "10:00:00",
    endTime: "11:00:00",
  };

  it("leaves a normal meeting e-mail exactly as before", () => {
    const normal = renderMeetingEmail(base);

    assert.doesNotMatch(normal.html, /Teams|Join/);
    assert.doesNotMatch(normal.text, /Teams|Join/);
    assert.match(normal.html, /<p><strong>End Time:<\/strong> 11:00 AM<\/p>\n/);
  });

  it("adds the meeting type and a clickable Join Meeting link when online", () => {
    const online = renderMeetingEmail({ ...base, online: { joinUrl: JOIN } });

    assert.match(online.html, /Meeting type:<\/strong> Microsoft Teams/);
    assert.match(online.html, /<a href="https:\/\/teams\.microsoft\.com[^"]*"[^>]*>Join Meeting<\/a>/);
    assert.match(online.text, /Meeting type: Microsoft Teams/);
    assert.ok(online.text.includes(`Join Meeting: ${JOIN}`));
  });

  it("escapes the join URL in HTML", () => {
    const evil = renderMeetingEmail({
      ...base,
      online: { joinUrl: 'https://teams.microsoft.com/x"><script>alert(1)</script>' },
    });

    assert.doesNotMatch(evil.html, /<script>/);
  });

  it("carries no join link on a cancellation", () => {
    const cancelled = renderMeetingEmail({
      ...base,
      kind: "cancelled",
      online: { joinUrl: JOIN },
    });

    assert.doesNotMatch(cancelled.html, /Join|Teams/);
    assert.doesNotMatch(cancelled.text, /Join|Teams/);
  });

  it("lists one link per occurrence in a series", () => {
    const L1 = `${JOIN}1`;
    const L2 = `${JOIN}2`;
    const email = renderMeetingEmail({
      ...base,
      series: {
        frequency: "Weekly",
        startDate: "2030-01-15",
        endDate: "2030-01-22",
        occurrences: [
          { date: "2030-01-15", startTime: "10:00:00", endTime: "11:00:00", joinUrl: L1 },
          { date: "2030-01-22", startTime: "10:00:00", endTime: "11:00:00", joinUrl: L2 },
          { date: "2030-01-29", startTime: "10:00:00", endTime: "11:00:00" },
        ],
        skippedDates: [],
        cancelledDates: [],
      },
    });

    assert.ok(email.html.includes(L1) && email.html.includes(L2));
    assert.ok(email.text.includes(`Join Meeting: ${L2}`));
    assert.match(email.text, /Meeting type: Microsoft Teams/);
    // The occurrence without a link (its Teams creation failed) has none.
    assert.match(email.text, /3\. 2030-01-29 \(Tue\), 10:00 AM - 11:00 AM\n/);
  });

  it("keeps the invitation unchanged for a normal meeting and adds the link when online", () => {
    const fields = {
      title: "Planning",
      organizerName: "Bob",
      roomName: "Alpha",
      meetingDate: "2030-01-15",
      startTime: "10:00:00",
      endTime: "11:00:00",
      acceptUrl: "https://app.test/a",
      declineUrl: "https://app.test/d",
    };

    const normal = renderInvitationEmail(fields);
    assert.doesNotMatch(normal.html + normal.text, /Teams|Join/);

    const online = renderInvitationEmail({ ...fields, joinUrl: JOIN, optional: true });
    assert.match(online.html, /Join Meeting<\/a>/);
    assert.ok(online.text.includes(`Join Meeting: ${JOIN}`));
    assert.match(online.html, /optional participant/);
  });
});
