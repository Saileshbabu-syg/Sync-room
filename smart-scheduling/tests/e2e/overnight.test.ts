import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting } from "@/db/schema";
import { weekOf } from "@/lib/booking-limits";
import { addDays } from "@/lib/report-period";
import { updateAppBookingSettings } from "@/lib/services/booking-settings.service";
import { updateGroup } from "@/lib/services/group.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { decodeQuotedPrintable } from "../helpers/smtp-sink";
import { startApp, type App } from "./harness";

// Overnight bookings over HTTP (production build, real sessions, local SMTP
// sink): the API accepts a meeting that crosses midnight only when the
// effective policy allows it, conflicts are detected across midnight, series
// are checked occurrence by occurrence, and the confirmation says the end is
// the next day. Nothing is sent outside this machine.

let app: App;
let f: Fixtures;
let admin: number;

const ALL = ["booking.create", "booking.view", "booking.cancel", "booking.priority", "booking.recurring"];

const APP = (over: Record<string, unknown> = {}) => ({
  allowOvernight: true,
  maxDurationMinutes: null,
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
  ...over,
});

const GROUP_OPEN = {
  maxDurationMinutes: null,
  maxAdvanceDays: null,
  maxOccurrences: null,
  overnightPolicy: "INHERIT",
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

before(async () => {
  f = await seedFixtures();
  admin = f.users.admin.employeeId;
  app = await startApp(3212);
});

after(() => app?.stop());

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE meeting_audit_logs, reminder_logs, notifications, meeting_attendees, meeting,
      recurring_meetings, group_audit_logs
    RESTART IDENTITY CASCADE
  `);

  app.sink.messages.length = 0;

  await updateAppBookingSettings(APP(), admin);

  for (const id of Object.values(f.groupIds)) {
    await updateGroup(
      id,
      { isActive: true, permissions: ALL, settings: GROUP_OPEN as never, roomIds: [] },
      admin
    );
  }
});

const MONDAY = weekOf(dateFromToday(15)).start;
const day = (n: number) => addDays(MONDAY, n);

const book = (user: { email: string }, date: string, start: string, end: string, over: Record<string, unknown> = {}) =>
  app.call("POST", "/api/meetings/booking", {
    as: user,
    body: {
      title: "Night shift",
      meeting_date: date,
      room_id: f.rooms.alpha.room_id,
      participant_count: 1,
      meeting_type_id: f.types.team,
      start_time: start,
      end_time: end,
      ...over,
    },
  });

const message = (res: { json?: Record<string, unknown> | null; text: string }) =>
  String(res.json?.message ?? res.text);

const stored = async () => (await db.select().from(meeting)).filter((m) => m.meetingStatusId !== 3);

describe("booking across midnight over HTTP", () => {
  it("books 11:00 PM to 01:00 AM on its start date and tells the form it is allowed", async () => {
    const policy = await app.call("GET", "/api/booking-policy", { as: f.users.bob });

    assert.equal((policy.json!.policy as { allowOvernight: boolean }).allowOvernight, true);

    const res = await book(f.users.bob, day(1), "23:00", "01:00");

    assert.equal(res.status, 201, res.text);

    const [row] = await stored();

    assert.equal(row.meeting_date, day(1));
    assert.equal(row.start_time, "23:00:00");
    assert.equal(row.end_time, "01:00:00");
  });

  it("is refused with a clear message when the application or the group does not allow it", async () => {
    await updateAppBookingSettings(APP({ allowOvernight: false }), admin);

    const off = await book(f.users.bob, day(1), "23:00", "01:00");

    assert.equal(off.status, 403);
    assert.match(message(off), /Overnight bookings are not permitted/);

    await updateAppBookingSettings(APP(), admin);
    await updateGroup(
      f.groupIds.employee,
      { settings: { ...GROUP_OPEN, overnightPolicy: "NOT_ALLOWED" } as never },
      admin
    );

    const group = await book(f.users.bob, day(1), "23:00", "01:00");

    assert.equal(group.status, 403);

    // The room search and the booking policy endpoint agree with the booking.
    const search = await app.call("POST", "/api/meetings/suggestions", {
      as: f.users.bob,
      body: { meeting_date: day(1), start_time: "23:00", end_time: "01:00", participant_count: 1 },
    });

    assert.equal(search.status, 403);

    // Another group (Manager) inherits the application's switch and may.
    assert.equal((await book(f.users.manager, day(1), "23:00", "01:00")).status, 201);
    assert.equal((await stored()).length, 1);
  });

  it("detects room conflicts across midnight, and the room search offers the free room", async () => {
    assert.equal((await book(f.users.bob, day(1), "23:00", "01:00")).status, 201);

    const clash = await book(f.users.carol, day(2), "00:30", "01:30");

    assert.equal(clash.status, 409);

    assert.equal((await book(f.users.carol, day(2), "01:00", "02:00")).status, 201);

    // Alpha is taken for 00:30 next morning; the search lists only Beta (the
    // booking page's room list, before anything is booked).
    const search = await app.call("POST", "/api/meetings/suggestions", {
      as: f.users.carol,
      body: { meeting_date: day(2), start_time: "00:30", end_time: "00:45", participant_count: 1 },
    });

    assert.equal(search.status, 200, search.text);

    const names = (search.json!.data as { room_name: string }[]).map((r) => r.room_name);

    assert.ok(!names.includes("Alpha"));
    assert.ok(names.includes("Beta"));
  });

  it("a zero-length slot and a too-short overnight slot are refused", async () => {
    assert.equal((await book(f.users.bob, day(1), "23:00", "23:00")).status, 400);
    assert.equal((await book(f.users.bob, day(1), "23:55", "00:05")).status, 400);
  });

  it("applies the group's longest meeting to the length across midnight", async () => {
    await updateAppBookingSettings(APP({ maxDurationMinutes: 120 }), admin);

    assert.equal((await book(f.users.bob, day(1), "23:00", "01:00")).status, 201);
    assert.equal((await book(f.users.bob, day(2), "22:00", "02:00")).status, 400);
  });

  it("counts it on its start date for the daily limit", async () => {
    await updateAppBookingSettings(APP({ maxBookingsPerDay: 1 }), admin);

    assert.equal((await book(f.users.bob, day(1), "23:00", "01:00")).status, 201);
    assert.equal((await book(f.users.carol, day(2), "09:00", "10:00")).status, 201);
    assert.equal((await book(f.users.carol, day(1), "09:00", "10:00")).status, 400);
  });

  it("confirms by e-mail with the end shown as the next day", async () => {
    assert.equal((await book(f.users.bob, day(1), "23:00", "01:00")).status, 201);

    const deadline = Date.now() + 8000;

    while (app.sink.messages.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const raw = app.sink.messages.find((m) => m.to.includes(f.users.bob.email))!.data;

    assert.ok(raw, "the confirmation reached the local sink");

    const text = decodeQuotedPrintable(raw);

    assert.match(text, /11:00 PM/);
    assert.match(text, /01:00 AM \(next day\)/);
  });
});

describe("series and moves over HTTP", () => {
  const series = (user: { email: string }, over: Record<string, unknown> = {}) =>
    app.call("POST", "/api/meetings/recurring", {
      as: user,
      body: {
        title: "Night series",
        meeting_date: day(1),
        room_id: f.rooms.alpha.room_id,
        participantCount: 1,
        meetingTypeId: f.types.team,
        start_time: "23:00",
        end_time: "01:00",
        frequency_id: 2,
        occurrence_count: 3,
        ...over,
      },
    });

  it("books a weekly overnight series, one meeting per occurrence", async () => {
    const res = await series(f.users.bob);

    assert.equal(res.status, 201, res.text);

    const rows = await stored();

    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((m) => m.meeting_date).sort(), [day(1), day(8), day(15)]);
  });

  it("refuses the whole series when one occurrence runs into an early-morning meeting", async () => {
    assert.equal((await book(f.users.carol, day(9), "00:30", "01:30")).status, 201);

    const res = await series(f.users.bob);

    assert.equal(res.status, 409);
    assert.equal((await stored()).length, 1);
  });

  it("refuses the whole series while overnight is off", async () => {
    await updateAppBookingSettings(APP({ allowOvernight: false }), admin);

    assert.equal((await series(f.users.bob)).status, 403);
    assert.equal((await stored()).length, 0);
  });

  it("reschedules a meeting to an overnight slot only when policy allows, re-checking conflicts", async () => {
    const created = await book(f.users.bob, day(1), "10:00", "11:00");

    assert.equal(created.status, 201, created.text);

    const [{ meeting_id: id }] = await stored();
    const move = (start: string, end: string) =>
      app.call("PATCH", `/api/meetings/reschedule/${id}`, {
        as: f.users.bob,
        body: { room_id: f.rooms.alpha.room_id, meeting_date: day(1), start_time: start, end_time: end },
      });

    assert.equal((await move("23:00", "01:00")).status, 200);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, id));

    assert.equal(row.end_time, "01:00:00");

    await updateAppBookingSettings(APP({ allowOvernight: false }), admin);

    assert.equal((await move("22:00", "02:00")).status, 403);
    assert.equal((await move("09:00", "10:00")).status, 200, "a same-day slot is still fine");
  });
});
