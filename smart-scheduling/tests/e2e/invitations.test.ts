import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { meeting, meeting_attendees } from "@/db/schema";
import { invitationToken } from "@/lib/invitation-token";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { startApp, type App } from "./harness";

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3198);
});

after(() => app?.stop());

// Bob books a meeting and invites Carol.
async function booking(overrides: Record<string, unknown> = {}) {
  const res = await app.call("POST", "/api/meetings/booking", {
    as: f.users.bob,
    body: {
      title: "Planning",
      meeting_date: dateFromToday(8),
      room_id: f.rooms.alpha.room_id,
      participant_count: 2,
      meeting_type_id: f.types.team,
      start_time: "10:00",
      end_time: "11:00",
      participantEmployeeIds: [f.users.carol.employeeId],
      ...overrides,
    },
  });

  assert.equal(res.status, 201, res.text);

  return res.json!.meetingId as number;
}

const answer = (
  meetingId: number,
  employeeId: number,
  action: string,
  token = invitationToken(meetingId, employeeId)
) =>
  app.call("POST", "/api/invitations/respond", {
    body: { meetingId, employeeId, token, action },
  });

const stored = async (meetingId: number, employeeId: number) =>
  (
    await db
      .select()
      .from(meeting_attendees)
      .where(
        and(
          eq(meeting_attendees.meeting_id, meetingId),
          eq(meeting_attendees.employee_id, employeeId)
        )
      )
  )[0].response_status;

const page = (meetingId: number, employeeId: number, action = "accept", token?: string) =>
  app.call(
    "GET",
    `/invite?m=${meetingId}&e=${employeeId}&t=${token ?? invitationToken(meetingId, employeeId)}&a=${action}`
  );

describe("invitation links", () => {
  it("opening the confirmation page saves nothing", async () => {
    const id = await booking();
    const res = await page(id, f.users.carol.employeeId, "decline");

    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Planning"));
    assert.equal(await stored(id, f.users.carol.employeeId), "NO_RESPONSE");
  });

  it("confirming records the answer, once", async () => {
    const id = await booking({ start_time: "12:00", end_time: "13:00" });
    const carol = f.users.carol.employeeId;

    assert.equal((await answer(id, carol, "accept")).status, 200);
    assert.equal(await stored(id, carol), "ACCEPTED");

    const again = await answer(id, carol, "decline");

    assert.equal(again.status, 409);
    assert.equal(await stored(id, carol), "ACCEPTED", "the first answer stands");

    const reopened = await page(id, carol, "decline");
    assert.match(reopened.text, /Already answered/);
  });

  it("rejects a forged, swapped or malformed token", async () => {
    const id = await booking({ start_time: "14:00", end_time: "15:00" });
    const carol = f.users.carol.employeeId;

    assert.equal((await answer(id, carol, "accept", "0".repeat(64))).status, 403);
    assert.equal((await answer(id, carol, "accept", "short")).status, 400);
    // Bob's token cannot answer for Carol.
    assert.equal((await answer(id, carol, "accept", invitationToken(id, f.users.bob.employeeId))).status, 403);
    assert.equal(await stored(id, carol), "NO_RESPONSE");

    assert.match((await page(id, carol, "accept", "0".repeat(64))).text, /not valid/);
  });

  it("a valid token cannot be used for someone who was not invited", async () => {
    const id = await booking({ start_time: "16:00", end_time: "17:00" });
    const manager = f.users.manager.employeeId;

    assert.equal((await answer(id, manager, "accept")).status, 403);
  });

  it("does not answer for a cancelled meeting", async () => {
    const id = await booking({ start_time: "08:00", end_time: "09:00" });

    await db.update(meeting).set({ meetingStatusId: 3 }).where(eq(meeting.meeting_id, id));

    assert.equal((await answer(id, f.users.carol.employeeId, "accept")).status, 410);
    assert.match((await page(id, f.users.carol.employeeId)).text, /cancelled/);
  });

  it("validates the request body", async () => {
    assert.equal(
      (await app.call("POST", "/api/invitations/respond", { body: { meetingId: 1 } })).status,
      400
    );
    assert.equal(
      (await app.call("POST", "/api/invitations/respond", { body: { meetingId: 1, employeeId: 2, token: "x".repeat(64), action: "maybe" } })).status,
      400
    );
    assert.equal(
      (await app.call("POST", "/api/invitations/respond", {
        body: { meetingId: 1, employeeId: 2, token: "0".repeat(64), action: "accept" },
        headers: { origin: "https://evil.example" },
      })).status,
      403
    );
  });
});

describe("editing a meeting keeps the answers that were given", () => {
  it("only newly added participants start without a response", async () => {
    const id = await booking({
      start_time: "18:00",
      end_time: "19:00",
      participant_count: 2,
    });

    await answer(id, f.users.carol.employeeId, "accept");

    const edit = await app.call("PATCH", `/api/meetings/edit/${id}`, {
      as: f.users.bob,
      body: {
        title: "Planning (updated)",
        participantCount: 3,
        participantEmployeeIds: [f.users.carol.employeeId, f.users.dave.employeeId],
      },
    });

    assert.equal(edit.status, 200, edit.text);
    assert.equal(await stored(id, f.users.carol.employeeId), "ACCEPTED", "Carol's answer is kept");
    assert.equal(await stored(id, f.users.dave.employeeId), "NO_RESPONSE");
    assert.equal(await stored(id, f.users.bob.employeeId), "ACCEPTED", "organizer");
  });
});
