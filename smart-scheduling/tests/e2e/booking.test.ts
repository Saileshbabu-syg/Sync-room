import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, recurring_meetings, room } from "@/db/schema";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { isRedirect, startApp, type App } from "./harness";

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3193);
});

after(() => app?.stop());

const book = (user: { email: string }, overrides: Record<string, unknown> = {}) =>
  app.call("POST", "/api/meetings/booking", {
    as: user,
    body: {
      title: "Planning",
      meeting_date: dateFromToday(6),
      room_id: f.rooms.alpha.room_id,
      participant_count: 2,
      meeting_type_id: f.types.team,
      start_time: "10:00",
      end_time: "11:00",
      participantEmployeeIds: [f.users.carol.employeeId],
      ...overrides,
    },
  });

const clear = () =>
  db.execute(sql`TRUNCATE meeting_audit_logs, reminder_logs, notifications, meeting_attendees, meeting, recurring_meetings RESTART IDENTITY CASCADE`);

const meetingCount = async () => (await db.select().from(meeting)).length;

describe("/booking/available-rooms (F-02: used to 500 for every user)", () => {
  const url = (o: Record<string, string> = {}) => {
    const q = new URLSearchParams({
      date: dateFromToday(6),
      start: "09:00",
      end: "10:00",
      participants: "3",
      ...o,
    });
    return `/booking/available-rooms?${q}`;
  };

  before(clear);

  it("renders the free rooms for a signed-in user (HTTP 200)", async () => {
    const res = await app.call("GET", url(), { as: f.users.bob });

    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Alpha"));
    assert.ok(res.text.includes("Beta"));
    assert.ok(!res.text.includes("Gamma"), "a room under maintenance is not offered");
  });

  it("respects capacity", async () => {
    const res = await app.call("GET", url({ participants: "6" }), { as: f.users.bob });

    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Alpha"));
    assert.ok(!res.text.includes("Beta"));
  });

  it("shows an empty state (not a crash) when nothing is free", async () => {
    const res = await app.call("GET", url({ participants: "11" }), { as: f.users.bob });

    assert.equal(res.status, 200);
    assert.ok(res.text.includes("no-rooms-available"));
    assert.ok(res.text.includes("No rooms available"));
  });

  it("does not offer a room that is already booked for the slot, but does offer back-to-back", async () => {
    assert.equal((await book(f.users.bob, { start_time: "09:00", end_time: "10:00", meeting_date: dateFromToday(6) })).status, 201);

    const overlapping = await app.call("GET", url({ start: "09:30", end: "10:30" }), { as: f.users.carol });
    assert.ok(!overlapping.text.includes("Alpha"));
    assert.ok(overlapping.text.includes("Beta"));

    const adjacent = await app.call("GET", url({ start: "10:00", end: "11:00" }), { as: f.users.carol });
    assert.ok(adjacent.text.includes("Alpha"), "starts exactly when the other meeting ends");
  });

  it("redirects anonymous users to /login with a real 3xx (no data, no fake 200)", async () => {
    const res = await app.call("GET", url());

    assert.ok(isRedirect(res.status), `status ${res.status}`);
    assert.match(res.location ?? "", /\/login/);
    assert.ok(!res.text.includes("Alpha"));
  });

  it("sends missing / malformed parameters back to the search form instead of crashing", async () => {
    for (const path of [
      "/booking/available-rooms",
      url({ date: "garbage" }),
      url({ participants: "abc" }),
      url({ start: "25:00" }),
      url({ end: "08:00" }),
      url({ date: dateFromToday(-3) }),
    ]) {
      const res = await app.call("GET", path, { as: f.users.bob });

      assert.ok(isRedirect(res.status), `${path} -> ${res.status}`);
      assert.match(res.location ?? "", /\/booking$/);
    }
  });

  it("the suggestions API behaves the same way: 401 without a session, 400 for bad input, 200 with data", async () => {
    const body = { meeting_date: dateFromToday(6), start_time: "12:00", end_time: "13:00", participant_count: 3 };

    assert.equal((await app.call("POST", "/api/meetings/suggestions", { body })).status, 401);

    const ok = await app.call("POST", "/api/meetings/suggestions", { as: f.users.bob, body });
    assert.equal(ok.status, 200);
    assert.ok((ok.json!.data as unknown[]).length >= 1);

    for (const bad of [
      {},
      { ...body, meeting_date: undefined },
      { ...body, participant_count: "abc" },
      { ...body, end_time: "12:05" },
      { ...body, meeting_date: dateFromToday(-1) },
      { ...body, meeting_date: "9999-01-01" },
      { ...body, start_time: "nope" },
    ]) {
      const res = await app.call("POST", "/api/meetings/suggestions", { as: f.users.bob, body: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });
});

describe("booking rules over HTTP", () => {
  before(clear);

  it("back-to-back meetings are accepted in both directions; overlaps are 409 (F-09)", async () => {
    assert.equal((await book(f.users.bob, { start_time: "10:00", end_time: "11:00" })).status, 201);
    assert.equal((await book(f.users.bob, { start_time: "11:00", end_time: "12:00" })).status, 201);
    assert.equal((await book(f.users.bob, { start_time: "09:00", end_time: "10:00" })).status, 201);

    for (const [s, e] of [["10:30", "11:30"], ["09:30", "10:30"], ["10:00", "11:00"], ["10:15", "10:45"]]) {
      const res = await book(f.users.carol, { start_time: s, end_time: e });
      assert.equal(res.status, 409, `${s}-${e}`);
      assert.match(String(res.json!.message), /already booked/);
    }

    assert.equal(await meetingCount(), 3);
  });

  it("invalid ordering / times / past dates are 400", async () => {
    for (const o of [
      { start_time: "11:00", end_time: "10:00" },
      { start_time: "10:00", end_time: "10:00" },
      { start_time: "10:00:00", end_time: "11:00:00" },
      { meeting_date: dateFromToday(-1) },
      { meeting_date: "2026-02-30" },
      { meeting_date: dateFromToday(400) },
    ]) {
      assert.equal((await book(f.users.bob, { ...o, start_time: o.start_time ?? "14:00", end_time: o.end_time ?? "15:00" })).status, 400, JSON.stringify(o));
    }
  });

  it("a room under maintenance cannot be booked, even by calling the API directly (F-06)", async () => {
    const res = await book(f.users.bob, { room_id: f.rooms.gamma.room_id, start_time: "14:00", end_time: "15:00" });

    assert.equal(res.status, 409);
    assert.match(String(res.json!.message), /unavailable/i);

    // a status change made after the page loaded is honoured
    await db.update(room).set({ availabilityStatusId: 2 }).where(eq(room.room_id, f.rooms.beta.room_id));
    assert.equal((await book(f.users.bob, { room_id: f.rooms.beta.room_id, participant_count: 2, start_time: "14:00", end_time: "15:00" })).status, 409);
    await db.update(room).set({ availabilityStatusId: 1 }).where(eq(room.room_id, f.rooms.beta.room_id));
    assert.equal((await book(f.users.bob, { room_id: f.rooms.beta.room_id, participant_count: 2, start_time: "14:00", end_time: "15:00" })).status, 201);
  });

  it("meeting types are limited by role (F-05)", async () => {
    // Employee: only Team / One-on-One / Others. One date per case so the
    // bookings can never conflict with each other.
    const cases = [
      ["client", 403],
      ["interview", 403],
      ["training", 403],
      ["team", 201],
      ["oneOnOne", 201],
      ["others", 201],
    ] as const;

    for (const [i, [type, expected]] of cases.entries()) {
      const res = await book(f.users.carol, {
        meeting_type_id: f.types[type],
        meeting_date: dateFromToday(30 + i),
        start_time: "08:00",
        end_time: "09:00",
        participantEmployeeIds: [],
        participant_count: 1,
      });

      assert.equal(res.status, expected, type);
    }
  });

  it("the type list offered to a user is the same list the server enforces", async () => {
    const names = async (user: typeof f.users.bob) =>
      ((await app.call("GET", "/api/meeting-types", { as: user })).json!.data as { meetingTypeName: string }[])
        .map((t) => t.meetingTypeName)
        .sort();

    assert.deepEqual(await names(f.users.bob), ["One-on-One", "Others", "Team Meeting"]);
    assert.deepEqual(await names(f.users.admin), ["One-on-One", "Others"]);
    assert.equal((await names(f.users.manager)).length, 6);
  });

  it("recurring series: type rule, maintenance and atomic conflict handling over HTTP", async () => {
    const series = (user: { email: string }, o: Record<string, unknown> = {}) =>
      app.call("POST", "/api/meetings/recurring", {
        as: user,
        body: {
          title: "Weekly sync",
          room_id: f.rooms.alpha.room_id,
          meeting_date: dateFromToday(40),
          start_time: "16:00",
          end_time: "16:30",
          participantCount: 2,
          meetingTypeId: f.types.team,
          frequency_id: 2,
          occurrence_count: 3,
          ...o,
        },
      });

    assert.equal((await series(f.users.bob, { meetingTypeId: f.types.client })).status, 403);
    assert.equal((await series(f.users.bob, { room_id: f.rooms.gamma.room_id })).status, 409);

    const before = await meetingCount();
    await book(f.users.carol, { meeting_date: dateFromToday(54), start_time: "16:15", end_time: "16:45", participantEmployeeIds: [], participant_count: 1 });

    const conflict = await series(f.users.bob);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.json!.conflicts, [dateFromToday(54)]);
    assert.equal(await meetingCount(), before + 1, "only the unrelated booking was added");

    const ok = await series(f.users.bob, { meeting_date: dateFromToday(41) });
    assert.equal(ok.status, 201);
    assert.equal((ok.json!.data as unknown[]).length, 3);
  });
});

describe("concurrency over HTTP (F-01)", () => {
  it("24 simultaneous requests from 4 users for one slot -> exactly one 201, the rest 409, one row", async () => {
    await clear();

    const racers = [f.users.bob, f.users.carol, f.users.manager, f.users.admin];
    const stamps: { start: number; end: number }[] = [];

    const responses = await Promise.all(
      Array.from({ length: 24 }, async (_, i) => {
        const start = performance.now();
        const user = racers[i % racers.length];

        const res = await book(user, {
          title: `race ${i}`,
          meeting_date: dateFromToday(8),
          // Admin may only book One-on-One / Others, the others use Others too
          meeting_type_id: f.types.others,
          participantEmployeeIds: [],
          participant_count: 1,
        });

        stamps.push({ start, end: performance.now() });
        return res.status;
      })
    );

    const created = responses.filter((s) => s === 201).length;
    const conflicts = responses.filter((s) => s === 409).length;

    assert.equal(created, 1, `statuses: ${responses.join(",")}`);
    assert.equal(conflicts, 23, `statuses: ${responses.join(",")}`);
    assert.equal(await meetingCount(), 1);

    assert.ok(
      Math.max(...stamps.map((s) => s.start)) < Math.min(...stamps.map((s) => s.end)),
      "requests really were in flight together"
    );
  });

  it("6 simultaneous recurring series for one slot -> exactly one series", async () => {
    await clear();

    const racers = [f.users.bob, f.users.carol];

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.call("POST", "/api/meetings/recurring", {
          as: racers[i % 2],
          body: {
            title: "Weekly sync",
            room_id: f.rooms.alpha.room_id,
            meeting_date: dateFromToday(9),
            start_time: "10:00",
            end_time: "11:00",
            participantCount: 1,
            meetingTypeId: f.types.others,
            frequency_id: 2,
            occurrence_count: 4,
          },
        }).then((r) => r.status)
      )
    );

    assert.equal(responses.filter((s) => s === 201).length, 1, responses.join(","));
    assert.equal(responses.filter((s) => s === 409).length, 5, responses.join(","));
    assert.equal(await meetingCount(), 4);
    assert.equal((await db.select().from(recurring_meetings)).length, 1);
  });

  it("different rooms and non-overlapping slots booked at the same moment all succeed", async () => {
    await clear();

    const jobs = [
      book(f.users.bob, { room_id: f.rooms.alpha.room_id, start_time: "09:00", end_time: "10:00", participantEmployeeIds: [], participant_count: 1 }),
      book(f.users.carol, { room_id: f.rooms.alpha.room_id, start_time: "10:00", end_time: "11:00", participantEmployeeIds: [], participant_count: 1 }),
      book(f.users.manager, { room_id: f.rooms.beta.room_id, start_time: "09:00", end_time: "10:00", participantEmployeeIds: [], participant_count: 1 }),
      book(f.users.admin, { room_id: f.rooms.beta.room_id, start_time: "10:00", end_time: "11:00", meeting_type_id: f.types.others, participantEmployeeIds: [], participant_count: 1 }),
    ];

    assert.deepEqual((await Promise.all(jobs)).map((r) => r.status), [201, 201, 201, 201]);
  });
});

describe("edit and cancel (F-19)", () => {
  let id: number;

  before(async () => {
    await clear();
    const res = await book(f.users.bob, { meeting_date: dateFromToday(10), participantEmployeeIds: [f.users.carol.employeeId], participant_count: 3 });
    id = res.json!.meetingId as number;
  });

  const edit = (body: unknown, user = f.users.bob) =>
    app.call("PATCH", `/api/meetings/edit/${id}`, { as: user, body });

  // Assert the status and include the response body in the failure message.
  const expectStatus = async (
    pending: ReturnType<typeof edit>,
    status: number | number[],
    label = ""
  ) => {
    const res = await pending;
    const accepted = Array.isArray(status) ? status : [status];

    assert.ok(accepted.includes(res.status), `${label} -> ${res.status} ${res.text}`);
  };

  // Waits until no new mail has arrived for `quietMs` (booking confirmations
  // are delivered asynchronously after the response).
  const settle = async (quietMs = 700) => {
    let last = -1;
    let stableSince = Date.now();

    while (Date.now() - stableSince < quietMs) {
      if (app.sink.messages.length !== last) {
        last = app.sink.messages.length;
        stableSince = Date.now();
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    return app.sink.messages.length;
  };

  it("an empty edit or an unchanged title is 'No changes detected' (400), not a silent 200 with a re-sent e-mail", async () => {
    const before = await settle();

    await expectStatus(edit({}), 400, "{}");
    await expectStatus(edit({ title: "Planning" }), 400, "same title");
    await expectStatus(edit({ participantCount: 3 }), 400, "same count");
    await expectStatus(edit({ participantEmployeeIds: [f.users.carol.employeeId] }), 400, "same attendees");

    assert.equal(await settle(), before, "no notification for non-changes");
  });

  it("omitting attendees leaves them alone; the headcount can't drop below the people invited", async () => {
    // 1 invited attendee + the organizer need a headcount of at least 2.
    await expectStatus(edit({ participantCount: 1 }), 400, "count below attendees");
    await expectStatus(edit({ title: "New title only" }), 200, "title only");

    const rows = await db.execute(sql`select count(*)::int as n from meeting_attendees where meeting_id = ${id}`);
    assert.equal(rows.rows[0].n, 2, "attendees untouched");
  });

  it("replacing attendees works and is applied together with the other fields", async () => {
    await expectStatus(
      edit({ participantEmployeeIds: [f.users.manager.employeeId], participantCount: 4 }),
      200,
      "replace attendees"
    );

    const rows = (await db.execute(sql`select employee_id from meeting_attendees where meeting_id = ${id}`)).rows
      .map((r) => r.employee_id as number)
      .sort((a, b) => a - b);

    assert.deepEqual(rows, [f.users.bob.employeeId, f.users.manager.employeeId].sort((a, b) => a - b));
  });

  it("changing the type is checked against the owner's role (F-05)", async () => {
    await expectStatus(edit({ meetingTypeId: f.types.client }), 403, "client");
    await expectStatus(edit({ meetingTypeId: f.types.oneOnOne }), 200, "one-on-one");
    await expectStatus(edit({ meetingTypeId: 999999 }), 404, "unknown type");
  });

  it("rejects bad input", async () => {
    for (const body of [{ title: "a b" }, { participantCount: -1 }, { participantEmployeeIds: [999999] }, { participantCount: 99 }]) {
      await expectStatus(edit(body), [400, 404], JSON.stringify(body));
    }
  });
});
