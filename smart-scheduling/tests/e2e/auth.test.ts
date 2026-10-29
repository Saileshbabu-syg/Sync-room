import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { employee } from "@/db/schema";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { isRedirect, mintSession, startApp, type App } from "./harness";

let app: App;
let f: Fixtures;
let bob: { email: string; name: string };

before(async () => {
  f = await seedFixtures();
  bob = f.users.bob;
  app = await startApp(3191);
});

after(() => app?.stop());

const DATE = () => dateFromToday(5);

const API: [string, string, unknown?][] = [
  ["GET", "/api/rooms"],
  ["POST", "/api/rooms", { roomName: "x", roomCapacity: 3, availabilityStatusId: 1 }],
  ["GET", "/api/rooms/1"],
  ["PATCH", "/api/rooms/1", { roomName: "x", roomCapacity: 3, availabilityStatusId: 1 }],
  ["DELETE", "/api/rooms/1"],
  ["PATCH", "/api/rooms/1/edit", { room_name: "x", room_capacity: 3, roomLocation: "l", availabilityStatusId: 1 }],
  ["GET", `/api/rooms/1/schedule?date=${"2030-01-01"}`],
  ["GET", "/api/meeting-types"],
  ["GET", "/api/recurrence-frequencies"],
  ["POST", "/api/meetings/booking", {}],
  ["POST", "/api/meetings/recurring", {}],
  ["POST", "/api/meetings/suggestions", {}],
  ["PATCH", "/api/meetings/edit/1", { title: "x" }],
  ["PATCH", "/api/meetings/cancel/1"],
  ["POST", "/api/notifications/email", { meetingId: 1 }],
];

const PAGES = [
  "/home", "/rooms", "/rooms/1", "/rooms/1/edit", "/rooms/1/book", "/booking",
  "/booking/details?roomId=1", "/booking/available-rooms?date=2030-01-01&start=10:00&end=11:00&participants=2",
  "/bookings", "/bookings/1", "/bookings/1/edit",
];

describe("authentication on the server (F-02/§5, HEAD had 11/12 routes open)", () => {
  for (const [method, path, body] of API) {
    it(`anonymous ${method} ${path.split("?")[0]} -> 401`, async () => {
      const res = await app.call(method, path, { body });

      assert.equal(res.status, 401);
      assert.ok(!/stack|at .*\.ts|select |insert /i.test(res.text), "no internals leaked");
    });
  }

  for (const page of PAGES) {
    it(`anonymous page ${page.split("?")[0]} redirects to /login`, async () => {
      const res = await app.call("GET", page);

      assert.ok(isRedirect(res.status), `status ${res.status}`);
      assert.match(res.location ?? "", /\/login/);
    });
  }

  it("a valid employee session is accepted", async () => {
    const res = await app.call("GET", "/api/rooms", { as: bob });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });
});

describe("forged, tampered, expired and unrecognised sessions", () => {
  const cookieWith = (value: string) => `authjs.session-token=${value}`;

  it("garbage / empty cookie values -> 401", async () => {
    for (const value of ["garbage", "", "a.b.c", "x".repeat(2000)]) {
      const res = await app.call("GET", "/api/rooms", { cookie: cookieWith(value) });
      assert.equal(res.status, 401, JSON.stringify(value.slice(0, 10)));
    }
  });

  it("signed with the wrong secret -> 401", async () => {
    const token = await mintSession(bob, { secret: "a-completely-different-secret-value-0123456789" });
    assert.equal((await app.call("GET", "/api/rooms", { cookie: cookieWith(token) })).status, 401);
  });

  it("wrong salt (cookie name) -> 401", async () => {
    const token = await mintSession(bob, { salt: "authjs.callback-url" });
    assert.equal((await app.call("GET", "/api/rooms", { cookie: cookieWith(token) })).status, 401);
  });

  it("tampered token -> 401", async () => {
    const token = await mintSession(bob);
    const flipped = token.slice(0, -4) + (token.slice(-4) === "AAAA" ? "BBBB" : "AAAA");

    assert.equal((await app.call("GET", "/api/rooms", { cookie: cookieWith(flipped) })).status, 401);
  });

  it("expired token -> 401", async () => {
    const token = await mintSession(bob, { maxAge: -3600 });
    assert.equal((await app.call("GET", "/api/rooms", { cookie: cookieWith(token) })).status, 401);
  });

  it("a bearer header is not a session", async () => {
    const token = await mintSession(bob);
    const res = await app.call("GET", "/api/rooms", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
  });

  it("a token without an e-mail, or for someone who is not an employee -> 401", async () => {
    const noEmail = await mintSession({ email: "" });
    assert.equal((await app.call("GET", "/api/rooms", { cookie: cookieWith(noEmail) })).status, 401);
    assert.equal((await app.call("GET", "/api/rooms", { as: { email: "ghost@example.test" } })).status, 401);
  });

  it("an employee who never signed in (no Organizer row) -> 401, and pages redirect instead of crashing (F-20)", async () => {
    assert.equal((await app.call("GET", "/api/rooms", { as: f.users.dave })).status, 401);

    for (const page of ["/home", "/rooms", "/bookings", "/booking"]) {
      const res = await app.call("GET", page, { as: f.users.dave });
      assert.ok(isRedirect(res.status), `${page} -> ${res.status}`);
      assert.match(res.location ?? "", /\/login/);
    }
  });

  it("a revoked session: removing/changing the Employee record cuts off a still-valid JWT", async () => {
    const token = await mintSession(bob);
    const asBob = { cookie: cookieWith(token) };

    assert.equal((await app.call("GET", "/api/rooms", asBob)).status, 200);

    await db
      .update(employee)
      .set({ email: "offboarded@example.test" })
      .where(eq(employee.employee_id, f.users.bob.employeeId));

    try {
      assert.equal((await app.call("GET", "/api/rooms", asBob)).status, 401);
      assert.equal(
        (await app.call("POST", "/api/meetings/booking", { ...asBob, body: {} })).status,
        401
      );
      const page = await app.call("GET", "/bookings", asBob);
      assert.ok(isRedirect(page.status));
    } finally {
      await db
        .update(employee)
        .set({ email: f.users.bob.email })
        .where(eq(employee.employee_id, f.users.bob.employeeId));
    }

    assert.equal((await app.call("GET", "/api/rooms", asBob)).status, 200);
  });

  it("the internal mail endpoint is closed when no INTERNAL_API_SECRET is configured", async () => {
    const withGuess = await app.call("POST", "/api/notifications/email", {
      body: { meetingId: 1 },
      headers: { "x-internal-secret": "guess" },
    });
    assert.equal(withGuess.status, 401);

    const withSession = await app.call("POST", "/api/notifications/email", {
      as: f.users.admin,
      body: { meetingId: 1 },
    });
    assert.equal(withSession.status, 401);
  });
});

describe("transport hardening (F-12, F-22)", () => {
  it("sends security headers and does not announce the framework", async () => {
    const res = await app.call("GET", "/login");

    for (const header of [
      "content-security-policy",
      "x-frame-options",
      "x-content-type-options",
      "strict-transport-security",
      "referrer-policy",
      "permissions-policy",
    ]) {
      assert.ok(res.headers.get(header), `missing ${header}`);
    }

    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(res.headers.get("content-security-policy")!, /object-src 'none'/);
  });

  it("does not grant CORS to a foreign origin", async () => {
    const res = await app.call("OPTIONS", "/api/meetings/booking", {
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });

    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("mutating routes refuse non-JSON bodies (415) and cross-site requests (403) even with a valid session", async () => {
    const body = { title: "x" };

    const plain = await app.call("POST", "/api/meetings/booking", {
      as: bob,
      rawBody: JSON.stringify(body),
      headers: { "content-type": "text/plain" },
    });
    assert.equal(plain.status, 415);

    const form = await app.call("POST", "/api/meetings/booking", {
      as: bob,
      rawBody: "title=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(form.status, 415);

    const crossSite = await app.call("POST", "/api/meetings/booking", {
      as: bob,
      body,
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);

    const foreignOrigin = await app.call("PATCH", "/api/meetings/cancel/1", {
      as: bob,
      headers: { origin: "https://evil.example" },
    });
    assert.equal(foreignOrigin.status, 403);
  });

  it("malformed JSON and malformed ids are client errors, not 500s (F-17)", async () => {
    const badJson = await app.call("POST", "/api/meetings/booking", {
      as: bob,
      rawBody: "{not json",
      headers: { "content-type": "application/json" },
    });
    assert.equal(badJson.status, 400);

    const empty = await app.call("POST", "/api/meetings/recurring", {
      as: bob,
      rawBody: "",
      headers: { "content-type": "application/json" },
    });
    assert.equal(empty.status, 400);

    for (const p of [
      ["PATCH", "/api/meetings/cancel/1.5"],
      ["PATCH", "/api/meetings/cancel/abc"],
      ["PATCH", "/api/meetings/cancel/99999999999"],
      ["PATCH", "/api/meetings/edit/abc"],
      ["PATCH", "/api/meetings/edit/99999999999"],
      ["GET", "/api/rooms/abc"],
      ["GET", "/api/rooms/99999999999"],
      ["GET", "/api/rooms/1/schedule?date=garbage"],
    ] as const) {
      const res = await app.call(p[0], p[1], { as: f.users.admin, body: p[0] === "PATCH" && p[1].includes("/edit/") ? { title: "x" } : undefined });
      assert.equal(res.status, 400, `${p[0]} ${p[1]} -> ${res.status}`);
      assert.ok(!/stack|\.ts:|pg|select /i.test(res.text), "no internals leaked");
    }

    assert.equal((await app.call("GET", "/api/rooms/99999", { as: bob })).status, 404);
    assert.equal((await app.call("PATCH", "/api/meetings/cancel/99999", { as: bob })).status, 404);

    const nul = await app.call("POST", "/api/meetings/booking", {
      as: bob,
      body: {
        title: "bad\u0000title", meeting_date: DATE(), room_id: 1, participant_count: 1,
        meeting_type_id: f.types.others, start_time: "10:00", end_time: "11:00",
      },
    });
    assert.equal(nul.status, 400);

    for (const page of ["/bookings/abc", "/bookings/99999999999", "/rooms/abc", "/bookings/abc/edit"]) {
      const res = await app.call("GET", page, { as: bob });
      assert.ok(isRedirect(res.status), `${page} -> ${res.status}`);
    }
  });
});
