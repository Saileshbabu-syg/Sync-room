import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, room_requests } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { isRedirect, startApp, type App } from "./harness";

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3196);
});

after(() => app?.stop());

beforeEach(() =>
  db.execute(sql`
    TRUNCATE meeting_audit_logs, reminder_logs, notifications,
      reschedule_requests, room_request_emails, room_request_holders,
      room_requests, meeting_attendees, meeting, recurring_meetings RESTART IDENTITY CASCADE
  `)
);

const slot = () => ({
  meeting_date: dateFromToday(6),
  room_id: f.rooms.alpha.room_id,
  start_time: "10:00",
  end_time: "11:00",
});

// Bob books Alpha 10:00-11:00 (equal priority to what Carol will ask for).
async function bobBooks() {
  const res = await app.call("POST", "/api/meetings/booking", {
    as: f.users.bob,
    body: {
      title: "Bob private review",
      participant_count: 2,
      meeting_type_id: f.types.team,
      participantEmployeeIds: [f.users.dave.employeeId],
      ...slot(),
    },
  });

  assert.equal(res.status, 201, res.text);

  return res.json!.meetingId as number;
}

const requestBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Carol client call",
  participant_count: 2,
  meeting_type_id: f.types.team,
  message: "Important client call at that time, could you release the room?",
  ...slot(),
  ...overrides,
});

const carolAsks = (overrides: Record<string, unknown> = {}) =>
  app.call("POST", "/api/room-requests", {
    as: f.users.carol,
    body: requestBody(overrides),
  });

describe("booking an occupied room", () => {
  it("is refused with the details needed to ask for it, and nothing is double-booked", async () => {
    await bobBooks();

    const res = await app.call("POST", "/api/meetings/booking", {
      as: f.users.carol,
      body: {
        title: "Carol call",
        participant_count: 2,
        meeting_type_id: f.types.team,
        ...slot(),
      },
    });

    assert.equal(res.status, 409);

    const conflict = res.json!.conflict as {
      requestable: boolean;
      bookings: { organizerName: string; roomName: string; title: string | null }[];
    };

    assert.equal(conflict.requestable, true);
    assert.equal(conflict.bookings.length, 1);
    assert.equal(conflict.bookings[0].organizerName, "Bob Employee");
    assert.equal(conflict.bookings[0].roomName, "Alpha");
    assert.equal(conflict.bookings[0].title, null, "Carol may not see Bob's title");
    assert.ok(!res.text.includes("Bob private review"));

    assert.equal((await db.select().from(meeting)).length, 1, "still one meeting");
  });

  it("the room page's Continue check lets the user go on instead of blocking (HTTP 200, occupied)", async () => {
    await bobBooks();

    const check = (overrides: Record<string, unknown> = {}) =>
      app.call("POST", "/api/meetings/suggestions", {
        as: f.users.carol,
        body: { participant_count: 2, ...slot(), ...overrides },
      });

    const occupied = await check();
    assert.equal(occupied.status, 200, occupied.text);
    assert.equal(occupied.json!.occupied, true);

    const free = await check({ start_time: "12:00", end_time: "13:00" });
    assert.equal(free.status, 200);
    assert.equal(free.json!.occupied, undefined);

    // Real problems are still errors.
    assert.equal((await check({ participant_count: 99 })).status, 400);
  });

  it("describes the booking in the way of one date (used by the recurring-series dialog)", async () => {
    await bobBooks();

    const q = new URLSearchParams({
      room_id: String(f.rooms.alpha.room_id),
      meeting_date: dateFromToday(6),
      start_time: "10:00",
      end_time: "11:00",
    });

    assert.equal((await app.call("GET", `/api/room-requests?${q}`)).status, 401);

    const res = await app.call("GET", `/api/room-requests?${q}`, { as: f.users.carol });
    assert.equal(res.status, 200, res.text);

    const conflict = res.json!.conflict as {
      requestable: boolean;
      bookings: { organizerName: string; title: string | null }[];
    };
    assert.equal(conflict.requestable, true);
    assert.equal(conflict.bookings[0].organizerName, "Bob Employee");
    assert.equal(conflict.bookings[0].title, null);

    assert.equal(
      (await app.call("GET", "/api/room-requests?room_id=abc", { as: f.users.carol })).status,
      400
    );
  });

  it("a free room still books normally", async () => {
    const res = await app.call("POST", "/api/meetings/booking", {
      as: f.users.carol,
      body: {
        title: "Carol call",
        participant_count: 2,
        meeting_type_id: f.types.team,
        ...slot(),
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.json!.conflict, undefined);
  });
});

describe("POST /api/room-requests", () => {
  it("stores the request for the signed-in user and returns its id", async () => {
    const heldId = await bobBooks();

    const res = await carolAsks();

    assert.equal(res.status, 201, res.text);

    const [row] = await db.select().from(room_requests);

    assert.equal(row.requester_employee_id, f.users.carol.employeeId);
    assert.equal(row.holder_meeting_id, heldId);
    assert.equal(row.holder_organizer_employee_id, f.users.bob.employeeId);
    assert.equal(row.status, "PENDING");
    assert.match(row.message, /Important client call/);
  });

  it("refuses a past date and stores nothing (the server checks, not just the date picker)", async () => {
    await bobBooks();

    const res = await app.call("POST", "/api/room-requests", {
      as: f.users.carol,
      body: requestBody({ meeting_date: dateFromToday(-1) }),
    });

    assert.equal(res.status, 400, res.text);
    assert.match(String(res.json!.message), /today|past/i);
    assert.equal((await db.select().from(room_requests)).length, 0);
  });

  it("needs a signed-in user and an allowed origin", async () => {
    await bobBooks();

    assert.equal(
      (await app.call("POST", "/api/room-requests", { body: requestBody() })).status,
      401
    );

    assert.equal(
      (
        await app.call("POST", "/api/room-requests", {
          as: f.users.carol,
          body: requestBody(),
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
      403
    );

    assert.equal((await db.select().from(room_requests)).length, 0);
  });

  it("validates the message", async () => {
    await bobBooks();

    for (const message of ["", "   ", "x".repeat(1001)]) {
      assert.equal((await carolAsks({ message })).status, 400);
    }
  });

  it("ignores any organizer, requester, booking or status the client sends", async () => {
    const heldId = await bobBooks();

    const res = await carolAsks({
      requester_employee_id: f.users.manager.employeeId,
      holder_organizer_employee_id: f.users.carol.employeeId,
      holder_meeting_id: 999,
      status: "APPROVED",
    });

    assert.equal(res.status, 201);

    const [row] = await db.select().from(room_requests);
    assert.equal(row.requester_employee_id, f.users.carol.employeeId);
    assert.equal(row.holder_organizer_employee_id, f.users.bob.employeeId);
    assert.equal(row.holder_meeting_id, heldId);
    assert.equal(row.status, "PENDING");
  });

  it("a repeated submit with the same key is the same request", async () => {
    await bobBooks();

    const body = { client_request_id: "e2e-retry-key-1" };

    assert.equal((await carolAsks(body)).status, 201);
    assert.equal((await carolAsks(body)).status, 200);
    assert.equal((await db.select().from(room_requests)).length, 1);
  });
});

describe("requesting several dates of a recurring series", () => {
  it("each booked date can be requested; each books by itself once its organizer approves", async () => {
    const dates = [dateFromToday(6), dateFromToday(13)];

    // Bob holds the room on both dates.
    for (const meeting_date of dates) {
      const res = await app.call("POST", "/api/meetings/booking", {
        as: f.users.bob,
        body: {
          title: "Bob weekly",
          participant_count: 2,
          meeting_type_id: f.types.team,
          ...slot(),
          meeting_date,
        },
      });

      assert.equal(res.status, 201, res.text);
    }

    // Carol asks for both with one message each; different dates never clash.
    const ids: number[] = [];

    for (const meeting_date of dates) {
      const res = await carolAsks({ meeting_date });

      assert.equal(res.status, 201, res.text);
      ids.push(res.json!.requestId as number);
    }

    assert.equal((await db.select().from(room_requests)).length, 2);

    // Bob approves both (releasing his own booking for each date): both book.
    for (const id of ids) {
      const res = await app.call("PATCH", `/api/room-requests/${id}`, {
        as: f.users.bob,
        body: { action: "approve", release_booking: true },
      });

      assert.equal(res.status, 200, res.text);
      assert.equal(res.json!.outcome, "booked");
    }

    const carols = await db
      .select()
      .from(meeting)
      .where(eq(meeting.organizerEmployeeId, f.users.carol.employeeId));

    assert.deepEqual(
      carols.map((m) => m.meeting_date).sort(),
      [...dates].sort()
    );
    assert.ok(carols.every((m) => m.meetingStatusId === MEETING_STATUS.SCHEDULED));
  });
});

describe("reviewing and deciding", () => {
  async function pendingRequest() {
    const heldId = await bobBooks();

    const res = await carolAsks();

    return { heldId, requestId: res.json!.requestId as number };
  }

  it("only the two people involved can open the review page", async () => {
    const { requestId } = await pendingRequest();
    const path = `/requests/${requestId}`;

    const organizer = await app.call("GET", path, { as: f.users.bob });
    assert.equal(organizer.status, 200);
    assert.ok(organizer.text.includes("Important client call"));

    assert.equal((await app.call("GET", path, { as: f.users.carol })).status, 200);

    assert.equal((await app.call("GET", path, { as: f.users.manager })).status, 404);
    assert.equal((await app.call("GET", path, { as: f.users.admin })).status, 404);
    assert.ok(isRedirect((await app.call("GET", path)).status));
  });

  it("opening the e-mail link decides nothing", async () => {
    const { requestId } = await pendingRequest();

    await app.call("GET", `/requests/${requestId}?intent=approve`, { as: f.users.bob });

    assert.equal((await db.select().from(room_requests))[0].status, "PENDING");
  });

  it("a stranger cannot approve or reject; the requester cannot approve their own", async () => {
    const { requestId } = await pendingRequest();

    for (const user of [f.users.manager, f.users.admin, f.users.carol]) {
      for (const action of ["approve", "reject", "release"]) {
        const res = await app.call("PATCH", `/api/room-requests/${requestId}`, {
          as: user,
          body: { action },
        });

        assert.equal(res.status, 404, `${user.email} ${action}`);
      }
    }

    assert.equal((await db.select().from(room_requests))[0].status, "PENDING");
  });

  it("the client cannot set the status", async () => {
    const { requestId } = await pendingRequest();

    const res = await app.call("PATCH", `/api/room-requests/${requestId}`, {
      as: f.users.bob,
      body: { action: "APPROVED", status: "APPROVED" },
    });

    assert.equal(res.status, 400);
  });

  it("approve with the booking still in place books nothing; release then completes it", async () => {
    const { heldId, requestId } = await pendingRequest();

    const approved = await app.call("PATCH", `/api/room-requests/${requestId}`, {
      as: f.users.bob,
      body: { action: "approve" },
    });

    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.json!.outcome, "awaiting_slot");
    assert.equal((await db.select().from(meeting)).length, 1, "nothing booked yet");

    const released = await app.call("PATCH", `/api/room-requests/${requestId}`, {
      as: f.users.bob,
      body: { action: "release" },
    });

    assert.equal(released.status, 200, released.text);
    assert.equal(released.json!.outcome, "booked");

    const [held] = await db.select().from(meeting).where(eq(meeting.meeting_id, heldId));
    assert.equal(held.meetingStatusId, MEETING_STATUS.CANCELLED);

    const booked = await db
      .select()
      .from(meeting)
      .where(eq(meeting.organizerEmployeeId, f.users.carol.employeeId));
    assert.equal(booked.length, 1);
    assert.equal(booked[0].meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("reject keeps the booking and records the reason", async () => {
    const { heldId, requestId } = await pendingRequest();

    const res = await app.call("PATCH", `/api/room-requests/${requestId}`, {
      as: f.users.bob,
      body: { action: "reject", reason: "Client visit on our side" },
    });

    assert.equal(res.status, 200);

    const [row] = await db.select().from(room_requests);
    assert.equal(row.status, "REJECTED");
    assert.equal(row.rejection_reason, "Client visit on our side");

    const [held] = await db.select().from(meeting).where(eq(meeting.meeting_id, heldId));
    assert.equal(held.meetingStatusId, MEETING_STATUS.SCHEDULED);

    assert.equal(
      (
        await app.call("PATCH", `/api/room-requests/${requestId}`, {
          as: f.users.bob,
          body: { action: "approve" },
        })
      ).status,
      409,
      "no contradictory decision"
    );
  });

  it("the requester can cancel and then sees it on their list", async () => {
    const { requestId } = await pendingRequest();

    const res = await app.call("PATCH", `/api/room-requests/${requestId}`, {
      as: f.users.carol,
      body: { action: "cancel" },
    });

    assert.equal(res.status, 200);

    const list = await app.call("GET", "/requests", { as: f.users.carol });
    assert.equal(list.status, 200);
    assert.ok(list.text.includes("Request cancelled"));
    assert.ok(list.text.includes("Alpha"));
  });
});
