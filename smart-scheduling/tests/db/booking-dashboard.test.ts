import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, meeting_attendees } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { addDays, resolvePeriod } from "@/lib/report-period";
import { createBooking } from "@/lib/services/booking.service";
import {
  getDashboardMetrics,
  iterateDashboardBookings,
  iterateDashboardParticipants,
  listDashboardBookings,
  type DashboardFilters,
} from "@/lib/services/booking-dashboard.service";
import {
  createReportStream,
  type ReportFormat,
} from "@/lib/services/report.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";

let f: Fixtures;

before(async () => {
  f = await seedFixtures();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE booking_priority_history, meeting_audit_logs, reminder_logs,
      notifications, reschedule_requests, meeting_attendees, meeting,
      recurring_meetings
    RESTART IDENTITY CASCADE
  `);
});

type Seed = {
  date: string;
  start?: string;
  end?: string;
  status?: number;
  title?: string;
  by?: keyof Fixtures["users"];
  room?: "alpha" | "beta";
  group?: number | null;
  priority?: number | null;
};

// Inserts a booking directly, so any date and status can be set up.
async function add(s: Seed) {
  const [row] = await db
    .insert(meeting)
    .values({
      title: s.title ?? "Sync",
      room_id: f.rooms[s.room ?? "alpha"].room_id,
      meeting_date: s.date,
      organizerEmployeeId: f.users[s.by ?? "bob"].employeeId,
      participantCount: 1,
      meetingTypeId: f.types.team,
      meetingStatusId: s.status ?? MEETING_STATUS.SCHEDULED,
      start_time: s.start ?? "10:00",
      end_time: s.end ?? "11:00",
      groupIdAtBooking: s.group === undefined ? f.groupIds.employee : s.group,
      priorityAtBooking: s.priority === undefined ? 5 : s.priority,
    })
    .returning();

  return row.meeting_id;
}

const filters = (
  params: Parameters<typeof resolvePeriod>[0],
  extra: Partial<DashboardFilters> = {}
): DashboardFilters => ({ period: resolvePeriod(params), sort: "asc", ...extra });

const ids = async (fl: DashboardFilters) =>
  (await listDashboardBookings(fl, 1, 100)).rows.map((r) => r.bookingId);

describe("date filters (start date based)", () => {
  it("daily shows only that date", async () => {
    const a = await add({ date: "2031-03-05" });
    await add({ date: "2031-03-04" });
    await add({ date: "2031-03-06" });

    assert.deepEqual(await ids(filters({ mode: "day", date: "2031-03-05" })), [a]);
  });

  it("weekly runs from the selected date through the next 6 days", async () => {
    await add({ date: "2031-03-04" }); // the day before the start
    const start = await add({ date: "2031-03-05" });
    const mid = await add({ date: "2031-03-08" });
    const last = await add({ date: "2031-03-11" });
    await add({ date: "2031-03-12" }); // the day after

    assert.deepEqual(
      (await ids(filters({ mode: "week", date: "2031-03-05" }))).sort(),
      [start, mid, last].sort()
    );
  });

  it("monthly runs from the selected date up to the day before the same date next month", async () => {
    await add({ date: "2031-03-04" });
    const first = await add({ date: "2031-03-05" });
    const inside = await add({ date: "2031-03-31" });
    const last = await add({ date: "2031-04-04" });
    await add({ date: "2031-04-05" });

    assert.deepEqual(
      (await ids(filters({ mode: "month", date: "2031-03-05" }))).sort(),
      [first, inside, last].sort()
    );
  });

  it("a custom range includes both end dates", async () => {
    await add({ date: "2031-03-04" });
    const start = await add({ date: "2031-03-05" });
    const end = await add({ date: "2031-03-07" });
    await add({ date: "2031-03-08" });

    assert.deepEqual(
      (await ids(filters({ mode: "range", start: "2031-03-05", end: "2031-03-07" }))).sort(),
      [start, end].sort()
    );
  });

  it("a late evening booking stays on its own date (dates are wall-clock, not UTC)", async () => {
    const late = await add({ date: "2031-03-05", start: "23:00", end: "23:45" });
    await add({ date: "2031-03-06", start: "00:15", end: "01:00" });

    assert.deepEqual(await ids(filters({ mode: "day", date: "2031-03-05" })), [late]);
  });

  it("metrics and records follow the same period", async () => {
    await add({ date: "2031-03-05", start: "09:00", end: "10:00" });
    await add({ date: "2031-03-11", start: "09:00", end: "11:00" });
    await add({ date: "2031-03-12", start: "09:00", end: "10:00" });

    const week = filters({ mode: "week", date: "2031-03-05" });
    const metrics = await getDashboardMetrics(week);

    assert.equal(metrics.totalBookings, 2);
    assert.equal(metrics.totalBookings, (await listDashboardBookings(week, 1, 100)).total);
    assert.equal(metrics.totalMeetingHours, 3);
  });
});

describe("metrics", () => {
  it("count each status, add confirmed hours and distinct rooms", async () => {
    const d = "2031-03-05";

    await add({ date: d, start: "09:00", end: "10:00" }); // scheduled, 60
    await add({ date: d, start: "10:00", end: "11:30", status: MEETING_STATUS.COMPLETED, room: "beta" }); // 90
    await add({ date: d, start: "12:00", end: "13:00", status: MEETING_STATUS.CANCELLED });
    await add({ date: d, start: "14:00", end: "15:00", status: MEETING_STATUS.PENDING_RESCHEDULE });

    assert.deepEqual(await getDashboardMetrics(filters({ mode: "day", date: d })), {
      totalBookings: 4,
      confirmedBookings: 2,
      cancelledBookings: 1,
      totalMeetingHours: 2.5,
      activeRooms: 2,
    });
  });

  it("are zero for an empty period", async () => {
    const metrics = await getDashboardMetrics(filters({ mode: "day", date: "2031-03-05" }));

    assert.equal(metrics.totalBookings, 0);
    assert.equal(metrics.totalMeetingHours, 0);
  });
});

describe("bumped bookings", () => {
  it("are listed as Bumped with who took the room, counted apart from confirmed, and exported", async () => {
    const date = dateFromToday(8);
    const base = {
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [date],
      startTime: "10:00",
      endTime: "11:00",
      organizerRole: "Manager",
      participantCount: 1,
      meetingTypeId: f.types.team,
      notify: false,
    };

    const low = (await createBooking({ ...base, title: "Low", organizerEmployeeId: f.users.bob.employeeId })).meetings[0];
    const high = (await createBooking({ ...base, title: "High", organizerEmployeeId: f.users.manager.employeeId })).meetings[0];

    // The low-priority booking really was preempted ...
    const [preempted] = await db.select().from(meeting).where(sql`meeting_id = ${low.meeting_id}`);
    assert.equal(preempted.meetingStatusId, MEETING_STATUS.PREEMPTED);

    // ... and the dashboard still lists it, under the user-facing name.
    const day = filters({ mode: "day", date });
    const { rows } = await listDashboardBookings(day, 1, 10);

    assert.deepEqual(rows.map((r) => r.bookingId).sort(), [low.meeting_id, high.meeting_id].sort());

    const bumpedRow = rows.find((r) => r.bookingId === low.meeting_id)!;
    const holder = rows.find((r) => r.bookingId === high.meeting_id)!;

    assert.equal(bumpedRow.status, "Replaced");
    assert.equal(bumpedRow.statusId, MEETING_STATUS.PREEMPTED, "the stored status is unchanged");
    assert.equal(holder.bumped, null);

    // Who took the room, and the details of their meeting.
    assert.ok(bumpedRow.bumped);
    assert.equal(bumpedRow.bumped.byName, f.users.manager.name);
    assert.equal(bumpedRow.bumped.byGroup, "Manager");
    assert.equal(bumpedRow.bumped.byBookingId, high.meeting_id);
    assert.equal(bumpedRow.bumped.title, "High");
    assert.equal(bumpedRow.bumped.meetingType, "Team Meeting");
    assert.equal(bumpedRow.bumped.roomName, "Alpha");
    assert.equal(bumpedRow.bumped.meetingDate, date);
    assert.equal(bumpedRow.bumped.startTime.slice(0, 5), "10:00");
    assert.equal(bumpedRow.bumped.endTime.slice(0, 5), "11:00");
    assert.match(bumpedRow.bumped.reason, /outranks/);

    // Counted as a booking and as bumped, but never as confirmed.
    const metrics = await getDashboardMetrics(day);

    assert.equal(metrics.totalBookings, 2);
    assert.equal(metrics.bumpedBookings, 1);
    assert.equal(metrics.confirmedBookings, 1);
    assert.equal(metrics.totalMeetingHours, 1, "a bumped meeting adds no meeting hours");
    assert.equal(metrics.activeRooms, 1);

    // The status filter finds it.
    assert.deepEqual(await ids({ ...day, statusId: MEETING_STATUS.PREEMPTED }), [low.meeting_id]);

    // The export has it too, with the same details.
    const exported: Record<number, string | undefined> = {};
    for await (const row of iterateDashboardBookings(day)) exported[row.bookingId] = row.bumped?.byName;

    assert.deepEqual(exported, { [low.meeting_id]: f.users.manager.name, [high.meeting_id]: undefined });
  });

  it("show both directions: the replaced booking points at the new one, and the new one lists what it replaced", async () => {
    const date = dateFromToday(10);
    const base = {
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [date],
      startTime: "10:00",
      endTime: "11:00",
      organizerRole: "Manager",
      participantCount: 3,
      meetingTypeId: f.types.team,
      notify: false,
    };

    const low = (
      await createBooking({
        ...base,
        title: "Original",
        organizerEmployeeId: f.users.bob.employeeId,
        participantEmployeeIds: [f.users.carol.employeeId],
      })
    ).meetings[0];

    const high = (
      await createBooking({
        ...base,
        title: "Takeover",
        organizerEmployeeId: f.users.manager.employeeId,
        participantEmployeeIds: [f.users.dave.employeeId],
        optionalParticipantEmployeeIds: [f.users.admin.employeeId],
      })
    ).meetings[0];

    const { rows } = await listDashboardBookings(filters({ mode: "day", date }), 1, 10);
    const original = rows.find((r) => r.bookingId === low.meeting_id)!;
    const taker = rows.find((r) => r.bookingId === high.meeting_id)!;

    // The replaced booking keeps its own people and names the replacement and its people.
    assert.deepEqual(original.participants.map((p) => p.name), [f.users.carol.name]);
    assert.equal(original.bumped!.byBookingId, high.meeting_id);
    assert.deepEqual(
      original.bumped!.participants.map((p) => [p.name, p.isOptional]),
      [
        [f.users.dave.name, false],
        [f.users.admin.name, true],
      ]
    );

    // The replacement lists the booking it replaced, with its organizer, group and people.
    assert.equal(taker.bumped, null);
    assert.equal(taker.replaced.length, 1);
    assert.equal(taker.replaced[0].bookingId, low.meeting_id);
    assert.equal(taker.replaced[0].title, "Original");
    assert.equal(taker.replaced[0].organizerName, f.users.bob.name);
    assert.equal(taker.replaced[0].organizerGroup, "Employee");
    assert.deepEqual(taker.replaced[0].participants.map((p) => p.name), [f.users.carol.name]);
    assert.match(taker.replaced[0].reason, /^Replaced by/);
    assert.deepEqual(original.replaced, []);
  });

  it("keep the original booking and its history", async () => {
    const date = dateFromToday(9);
    const base = {
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [date],
      startTime: "10:00",
      endTime: "11:00",
      organizerRole: "Manager",
      participantCount: 2,
      meetingTypeId: f.types.team,
      notify: false,
    };

    const low = (
      await createBooking({
        ...base,
        title: "Original",
        organizerEmployeeId: f.users.bob.employeeId,
        participantEmployeeIds: [f.users.carol.employeeId],
      })
    ).meetings[0];

    await createBooking({ ...base, title: "Takeover", organizerEmployeeId: f.users.manager.employeeId });

    const [kept] = await db.select().from(meeting).where(sql`meeting_id = ${low.meeting_id}`);

    assert.equal(kept.title, "Original");
    assert.equal(kept.start_time.slice(0, 5), "10:00");
    assert.equal(
      (await db.select().from(meeting_attendees).where(sql`meeting_id = ${low.meeting_id}`)).length,
      2,
      "its participants are kept"
    );
    assert.equal(
      (await db.execute(sql`SELECT count(*)::int n FROM booking_priority_history WHERE affected_booking_id = ${low.meeting_id}`)).rows[0].n,
      1
    );
  });
});

describe("participants on the dashboard", () => {
  it("lists mandatory and optional participants with their answers, and not the organizer", async () => {
    const id = await add({ date: "2031-03-05" });

    await db.insert(meeting_attendees).values([
      { meeting_id: id, employee_id: f.users.bob.employeeId, response_status: "ACCEPTED" },
      { meeting_id: id, employee_id: f.users.carol.employeeId, response_status: "ACCEPTED" },
      { meeting_id: id, employee_id: f.users.dave.employeeId, response_status: "DECLINED", is_optional: true },
    ]);

    const [row] = (await listDashboardBookings(filters({ mode: "day", date: "2031-03-05" }), 1, 10)).rows;

    assert.deepEqual(
      row.participants.map((p) => [p.name, p.isOptional, p.response]),
      [
        [f.users.carol.name, false, "ACCEPTED"],
        [f.users.dave.name, true, "DECLINED"],
      ]
    );
  });

  it("exports one row per participant for exactly the filtered bookings, in batches", async () => {
    const inside = await add({ date: "2031-03-05" });
    const outside = await add({ date: "2031-03-20" });

    for (const meetingId of [inside, outside]) {
      await db.insert(meeting_attendees).values([
        { meeting_id: meetingId, employee_id: f.users.bob.employeeId, response_status: "ACCEPTED" },
        { meeting_id: meetingId, employee_id: f.users.carol.employeeId },
        { meeting_id: meetingId, employee_id: f.users.dave.employeeId, is_optional: true },
      ]);
    }

    const fl = filters({ mode: "week", date: "2031-03-05" });
    const seen: [number, number, boolean][] = [];

    for await (const p of iterateDashboardParticipants(fl, 1)) {
      seen.push([p.bookingId, p.employeeId, p.isOptional]);
    }

    assert.deepEqual(seen, [
      [inside, f.users.carol.employeeId, false],
      [inside, f.users.dave.employeeId, true],
    ]);
  });
});

describe("booking list", () => {
  const week = { mode: "week", date: "2031-03-05" };

  it("returns the meeting type, organizer and priority for each row", async () => {
    await add({ date: "2031-03-05", by: "manager", group: f.groupIds.manager, priority: 3 });
    await add({ date: "2031-03-06", group: null, priority: null });

    const [first, second] = (await listDashboardBookings(filters(week), 1, 10)).rows;

    assert.equal(first.organizerName, f.users.manager.name);
    assert.equal(first.meetingType, "Team Meeting");
    assert.equal(first.priorityAtBooking, 3);
    assert.equal(first.roomName, "Alpha");
    assert.equal(first.status, "Scheduled");
    assert.equal(second.priorityAtBooking, null, "older bookings have no stored priority");
    assert.ok(!("durationMinutes" in first) && !("createdAt" in first) && !("preemptedCount" in first));
  });

  it("pages ten bookings at a time without skipping or repeating any", async () => {
    for (let i = 0; i < 25; i++) {
      await add({
        date: addDays("2031-03-05", i % 7),
        start: `${String(8 + Math.floor(i / 7)).padStart(2, "0")}:00`,
        end: `${String(9 + Math.floor(i / 7)).padStart(2, "0")}:00`,
      });
    }

    const fl = filters(week);
    const pages = await Promise.all([1, 2, 3].map((p) => listDashboardBookings(fl, p, 10)));

    assert.deepEqual(pages.map((p) => p.rows.length), [10, 10, 5]);
    assert.equal(pages[0].total, 25);

    const all = pages.flatMap((p) => p.rows.map((r) => r.bookingId));

    assert.equal(new Set(all).size, 25);
    assert.deepEqual(all, await ids(fl));
  });

  it("lists participants with their response, without the organizer", async () => {
    const id = await add({ date: "2031-03-05" });

    await db.insert(meeting_attendees).values([
      { meeting_id: id, employee_id: f.users.bob.employeeId, response_status: "ACCEPTED" },
      { meeting_id: id, employee_id: f.users.carol.employeeId, response_status: "ACCEPTED" },
      { meeting_id: id, employee_id: f.users.dave.employeeId, response_status: "DECLINED" },
      { meeting_id: id, employee_id: f.users.manager.employeeId },
    ]);

    const [row] = (await listDashboardBookings(filters(week), 1, 10)).rows;

    assert.deepEqual(
      row.participants.map((p) => [p.name, p.employeeId, p.email, p.response]),
      [
        [f.users.carol.name, f.users.carol.employeeId, f.users.carol.email, "ACCEPTED"],
        [f.users.dave.name, f.users.dave.employeeId, f.users.dave.email, "DECLINED"],
        [f.users.manager.name, f.users.manager.employeeId, f.users.manager.email, "NO_RESPONSE"],
      ]
    );
  });

  it("has an empty participant list for a meeting nobody was invited to", async () => {
    await add({ date: "2031-03-05" });

    assert.deepEqual((await listDashboardBookings(filters(week), 1, 10)).rows[0].participants, []);
  });

  it("filters by group, room and status", async () => {
    const e = await add({ date: "2031-03-05" });
    const m = await add({ date: "2031-03-05", start: "12:00", end: "13:00", by: "manager", group: f.groupIds.manager, priority: 3, room: "beta" });
    const c = await add({ date: "2031-03-05", start: "14:00", end: "15:00", status: MEETING_STATUS.CANCELLED });

    assert.deepEqual(await ids(filters(week, { groupId: f.groupIds.manager })), [m]);
    assert.deepEqual(await ids(filters(week, { roomId: f.rooms.beta.room_id })), [m]);
    assert.deepEqual(await ids(filters(week, { statusId: MEETING_STATUS.CANCELLED })), [c]);
    assert.deepEqual((await ids(filters(week, { groupId: f.groupIds.employee }))).sort(), [e, c].sort());
  });

  it("searches organizer name, e-mail and meeting title", async () => {
    const bob = await add({ date: "2031-03-05", title: "Budget review" });
    const mona = await add({ date: "2031-03-05", start: "12:00", end: "13:00", by: "manager", title: "Roadmap" });

    assert.deepEqual(await ids(filters(week, { search: "bob" })), [bob]);
    assert.deepEqual(await ids(filters(week, { search: "MONA.MANAGER@" })), [mona]);
    assert.deepEqual(await ids(filters(week, { search: "budget" })), [bob]);
    assert.deepEqual(await ids(filters(week, { search: "nobody" })), []);
  });

  it("treats % and _ in the search as plain characters", async () => {
    await add({ date: "2031-03-05", title: "100% done" });
    const underscore = await add({ date: "2031-03-05", start: "12:00", end: "13:00", title: "a_b" });

    assert.equal((await ids(filters(week, { search: "%" }))).length, 1);
    assert.deepEqual(await ids(filters(week, { search: "a_b" })), [underscore]);
  });

  it("sorts by date and time", async () => {
    const a = await add({ date: "2031-03-06", start: "09:00", end: "10:00" });
    const b = await add({ date: "2031-03-06", start: "11:00", end: "12:00" });
    const c = await add({ date: "2031-03-08", start: "08:00", end: "09:00" });

    assert.deepEqual(await ids(filters(week, { sort: "asc" })), [a, b, c]);
    assert.deepEqual(await ids(filters(week, { sort: "desc" })), [c, b, a]);
  });

  it("the export iterator returns exactly the table's records, in order, across batches", async () => {
    for (let i = 0; i < 7; i++) {
      await add({ date: "2031-03-05", start: `${String(8 + i).padStart(2, "0")}:00`, end: `${String(9 + i).padStart(2, "0")}:00` });
    }

    const fl = filters(week, { sort: "desc" });
    const fromIterator: number[] = [];

    for await (const row of iterateDashboardBookings(fl, 3)) fromIterator.push(row.bookingId);

    assert.deepEqual(fromIterator, await ids(fl));
    assert.equal(fromIterator.length, 7);
  });
});

describe("report downloads", () => {
  const week = { mode: "week", date: "2031-03-05" };

  async function download(format: ReportFormat, fl: DashboardFilters) {
    const stream = await createReportStream(format, fl, "Test Viewer <viewer@example.test>");

    return Buffer.from(await new Response(stream).arrayBuffer());
  }

  async function seedReportData() {
    await add({ date: "2031-03-05", title: "Plain" });
    await add({ date: "2031-03-06", start: "12:00", end: "13:00", status: MEETING_STATUS.CANCELLED, title: 'Has, comma and "quote"' });
    await add({ date: "2031-03-07", start: "09:00", end: "10:00", by: "manager", group: f.groupIds.manager, priority: 3, title: "=HYPERLINK(\"x\")" });
    await add({ date: "2031-03-20", title: "Outside the week" });
    await add({ date: "2031-03-08", status: MEETING_STATUS.PREEMPTED, title: "Was preempted" });
  }

  it("CSV has the summary, the header and one line per filtered booking", async () => {
    await seedReportData();

    const text = (await download("csv", filters(week))).toString("utf8");

    assert.ok(text.startsWith("﻿"), "UTF-8 byte order mark for Excel");
    assert.match(text, /Report generated,/);
    assert.match(text, /Reporting period,2031-03-05 to 2031-03-11\r\n/);
    assert.match(text, /Total bookings,4\r\n/);
    assert.match(text, /Confirmed bookings,2\r\n/);
    assert.match(text, /Cancelled bookings,1\r\n/);
    assert.match(text, /Total meeting hours,2\r\n/);

    // Participants follow the bookings in their own table.
    assert.ok(text.includes("\r\nParticipants\r\n"));
    assert.match(text, /Booking ID,Organizer name,Organizer email,Group,Meeting type,Priority/);

    assert.match(text, /"Has, comma and ""quote"""/);
    assert.ok(!text.includes("Outside the week"), "outside the period");
    assert.ok(text.includes("Was preempted"), "replaced bookings are exported");
    assert.ok(text.includes("Replaced bookings,1"));
    assert.ok(text.includes("'=HYPERLINK"), "formula text is neutralized");
  });

  it("CSV honours the group, room, status and search filters", async () => {
    await seedReportData();

    const cancelled = (await download("csv", filters(week, { statusId: MEETING_STATUS.CANCELLED }))).toString("utf8");

    assert.match(cancelled, /Total bookings,1\r\n/);
    assert.ok(cancelled.includes("Has, comma"));
    assert.ok(!cancelled.includes("Plain"));

    const search = (await download("csv", filters(week, { search: "mona" }))).toString("utf8");
    assert.match(search, /Total bookings,1\r\n/);
  });

  it("XLSX opens as a workbook with a summary sheet and the same records", async () => {
    await seedReportData();

    const fl = filters(week);
    const buffer = await download("xlsx", fl);

    assert.equal(buffer.subarray(0, 2).toString(), "PK", "an xlsx is a zip");

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);

    const summary = book.getWorksheet("Summary")!;
    const labels = new Map<string, unknown>();
    summary.eachRow((row) => labels.set(String(row.getCell(1).value), row.getCell(2).value));

    assert.equal(labels.get("Total bookings"), 4);
    assert.equal(labels.get("Confirmed bookings"), 2);
    assert.equal(labels.get("Reporting period"), "2031-03-05 to 2031-03-11");

    const sheet = book.getWorksheet("Bookings")!;
    const expected = await ids(fl);

    assert.equal(sheet.rowCount, expected.length + 1);
    assert.deepEqual(
      sheet.getRows(2, expected.length)!.map((r) => Number(r.getCell(1).value)),
      expected
    );
    assert.equal(sheet.getRow(1).getCell(2).value, "Organizer name");
  });

  it("PDF is a PDF document", async () => {
    await seedReportData();

    const buffer = await download("pdf", filters(week));

    assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
    assert.ok(buffer.length > 1000);
  });

  it("an empty period still produces a valid report", async () => {
    const fl = filters({ mode: "day", date: "2031-03-05" });

    assert.match((await download("csv", fl)).toString("utf8"), /Total bookings,0\r\n/);
    assert.equal((await download("pdf", fl)).subarray(0, 5).toString(), "%PDF-");
  });

  it("a large result is written in batches", async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => ({
      title: `Bulk ${i}`,
      room_id: f.rooms.alpha.room_id,
      meeting_date: "2031-03-05",
      organizerEmployeeId: f.users.bob.employeeId,
      participantCount: 1,
      meetingTypeId: f.types.team,
      meetingStatusId: MEETING_STATUS.CANCELLED,
      start_time: "10:00",
      end_time: "11:00",
    }));

    await db.insert(meeting).values(rows);

    const text = (await download("csv", filters(week))).toString("utf8");

    assert.equal(text.split("\r\n").filter((l) => l.includes(",Bulk ")).length, 2300);
  });
});
