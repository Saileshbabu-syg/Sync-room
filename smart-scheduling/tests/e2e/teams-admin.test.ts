import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { meeting } from "@/db/schema";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { startApp, type App } from "./harness";

// Phase 5 over HTTP: online bookings return at once (Teams in the
// background), and the Admin-only Teams status, retry and health endpoints.

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3203);
});

after(() => app?.stop());

describe("online booking over HTTP", () => {
  it("is booked at once with Teams PENDING, whatever Microsoft is doing", async () => {
    const res = await app.call("POST", "/api/meetings/booking", {
      as: f.users.bob,
      body: {
        title: "Online sync",
        meeting_date: dateFromToday(9),
        room_id: f.rooms.alpha.room_id,
        participant_count: 1,
        meeting_type_id: f.types.team,
        start_time: "11:00",
        end_time: "11:30",
        onlineMeeting: true,
      },
    });

    assert.equal(res.status, 201, res.text);
    const body = JSON.parse(res.text) as { meetingId: number; online?: { pending: number } };
    assert.equal(body.online?.pending, 1);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, body.meetingId));
    assert.equal(row.online_requested, true);
    // The server has no Teams configuration in tests: the worker (fired after
    // the commit) marks it FAILED; either way the booking stands.
    assert.ok(["PENDING", "FAILED"].includes(row.online_status));
    assert.equal(row.meetingStatusId, 1);
  });
});

describe("Teams administration (Admin role only)", () => {
  let failedId: number;

  before(async () => {
    const [m] = await db
      .insert(meeting)
      .values({
        title: "Board review",
        room_id: f.rooms.beta.room_id,
        meeting_date: dateFromToday(10),
        start_time: "09:00",
        end_time: "10:00",
        organizerEmployeeId: f.users.bob.employeeId,
        participantCount: 1,
        meetingTypeId: f.types.team,
        meetingStatusId: 1,
        online_requested: true,
        online_status: "FAILED",
        online_attempts: 5,
        online_last_error: "The Teams app is not permitted to create the Teams meeting in the organizer mailbox.",
      })
      .returning();

    failedId = m.meeting_id;
  });

  it("lists failed provisioning with the reason; others get 403 / 401", async () => {
    const res = await app.call("GET", "/api/admin/teams", { as: f.users.admin });
    assert.equal(res.status, 200, res.text);

    const body = JSON.parse(res.text) as { counts: Record<string, number>; records: { meetingId: number; lastError: string; attempts: number }[] };
    const record = body.records.find((r) => r.meetingId === failedId);
    assert.ok(record);
    assert.equal(record.attempts, 5);
    assert.match(record.lastError, /not permitted/);

    assert.equal((await app.call("GET", "/api/admin/teams", { as: f.users.bob })).status, 403);
    assert.equal((await app.call("GET", "/api/admin/teams", { as: f.users.manager })).status, 403);
    assert.equal((await app.call("GET", "/api/admin/teams")).status, 401);
    assert.equal((await app.call("GET", "/api/admin/teams?status=EVERYTHING", { as: f.users.admin })).status, 400);
  });

  it("an Admin can retry it; nobody else can", async () => {
    assert.equal(
      (await app.call("POST", "/api/admin/teams/retry", { as: f.users.bob, body: { meetingId: failedId } })).status,
      403
    );

    const ok = await app.call("POST", "/api/admin/teams/retry", { as: f.users.admin, body: { meetingId: failedId } });
    assert.equal(ok.status, 202, ok.text);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, failedId));
    assert.notEqual(row.online_attempts, 5, "attempts reset");
  });

  it("the health check reports the missing configuration without exposing anything", async () => {
    assert.equal((await app.call("GET", "/api/admin/teams/health", { as: f.users.bob })).status, 403);

    const res = await app.call("GET", "/api/admin/teams/health", { as: f.users.admin });
    assert.equal(res.status, 200, res.text);

    const body = JSON.parse(res.text) as { healthy: boolean; health: { configuration: { ok: boolean; problems: string[] } } };
    assert.equal(body.healthy, false);
    assert.equal(body.health.configuration.ok, false);
    assert.ok(body.health.configuration.problems.some((p) => /TEAMS_TENANT_ID/.test(p)));
    assert.doesNotMatch(res.text, /secret=|access_token|Bearer/);
  });
});
