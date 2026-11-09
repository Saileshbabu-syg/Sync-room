import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  groupRooms,
  meeting,
  meeting_attendees,
  notifications,
  recurrence_frequency_master,
  recurringMeetingSkippedDates,
  recurring_meetings,
} from "@/db/schema";
import { MEETING_STATUS, PERMISSION } from "@/lib/constants";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import { loadSeriesEmailContext } from "@/lib/services/meeting-series.service";
import { deliverNotification } from "@/lib/services/notification.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { rescheduleMeeting } from "@/lib/services/reschedule.service";
import {
  cancelMeetings,
  changeSeriesEnd,
  editSeries,
  getSeriesDetails,
  lifecycleError,
} from "@/lib/services/series.service";
import { nowInAppTimezone } from "@/lib/time";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

// Phase 4: B-04 (move a scheduled meeting), H-1 (series edit / cancel by
// scope), L-1 (skipped dates), L-2 (every N weeks, end-by date), and the
// approved B-05 / B-09 / B-10 decisions.

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

beforeEach(async () => {
  f = await seedFixtures();
  mail?.restore();
  mail = captureMail();
});

after(() => mail?.restore());

const bob = () => ({ employeeId: f.users.bob.employeeId, role: "Employee" });
const carol = () => ({ employeeId: f.users.carol.employeeId, role: "Employee" });
const admin = () => ({ employeeId: f.users.admin.employeeId, role: "Admin" });

const input = (o: Partial<BookingInput> = {}): BookingInput => ({
  title: "Planning",
  roomId: f.rooms.alpha.room_id,
  occurrenceDates: [dateFromToday(7)],
  startTime: "10:00",
  endTime: "11:00",
  organizerEmployeeId: f.users.bob.employeeId,
  organizerRole: "Employee",
  participantCount: 2,
  meetingTypeId: f.types.team,
  participantEmployeeIds: [f.users.carol.employeeId],
  notify: false,
  ...o,
});

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  const known = lifecycleError(error);

  assert.ok(known, `expected a lifecycle error, got ${String(error)}`);

  return known;
}

const row = async (id: number) =>
  (await db.select().from(meeting).where(eq(meeting.meeting_id, id)))[0];

const rowsOf = async (seriesId: number) =>
  db
    .select()
    .from(meeting)
    .where(eq(meeting.recurringMeetingId, seriesId))
    .orderBy(asc(meeting.meeting_date));

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
const prop = (ics: string, name: string) =>
  unfold(ics).split("\r\n").find((l) => l.startsWith(`${name}:`));

const frequencyId = async (name: string) =>
  (
    await db
      .select({ id: recurrence_frequency_master.frequency_id })
      .from(recurrence_frequency_master)
      .where(eq(recurrence_frequency_master.frequency_name, name))
  )[0].id;

// Weekly series of 4, Bob organizing, Carol invited (and accepting).
async function weeklySeries(o: Partial<Parameters<typeof createRecurringMeeting>[0]> = {}) {
  const { meetings, recurringMeetingId } = await createRecurringMeeting({
    title: "Standup",
    room_id: f.rooms.alpha.room_id,
    meeting_date: dateFromToday(7),
    start_time: "10:00",
    end_time: "10:30",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 2,
    meetingTypeId: f.types.team,
    frequency_id: await frequencyId("WEEKLY"),
    occurrence_count: 4,
    participantEmployeeIds: [f.users.carol.employeeId],
    notify: false,
    ...o,
  });

  await db
    .update(meeting_attendees)
    .set({ response_status: "ACCEPTED" })
    .where(eq(meeting_attendees.employee_id, f.users.carol.employeeId));

  const ids = [...meetings]
    .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date))
    .map((m) => m.meeting_id);

  return { seriesId: recurringMeetingId, ids };
}

const notificationsFor = async (ids: number[]) =>
  db.select().from(notifications).where(inArray(notifications.meeting_id, ids));

describe("B-04: moving a scheduled meeting", () => {
  it("the organizer moves it: same meeting, attendees keep their answers, calendar version rises, update queued", async () => {
    const { meetings: [m] } = await createBooking(input());
    await db.update(meeting_attendees).set({ response_status: "ACCEPTED" });
    const before = await row(m.meeting_id);

    const { notificationId } = await rescheduleMeeting({
      meetingId: m.meeting_id,
      actor: bob(),
      roomId: f.rooms.beta.room_id,
      meetingDate: dateFromToday(8),
      startTime: "14:00",
      endTime: "14:45",
      notify: false,
    });

    const after = await row(m.meeting_id);
    assert.equal(after.meeting_id, before.meeting_id);
    assert.equal(after.organizerEmployeeId, before.organizerEmployeeId);
    assert.deepEqual([after.room_id, after.meeting_date, after.start_time, after.end_time], [
      f.rooms.beta.room_id,
      dateFromToday(8),
      "14:00:00",
      "14:45:00",
    ]);
    assert.equal(after.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(after.ics_sequence, before.ics_sequence + 1);

    const [carolRow] = await db.select().from(meeting_attendees).where(eq(meeting_attendees.employee_id, f.users.carol.employeeId));
    assert.equal(carolRow.response_status, "ACCEPTED");

    // Queued with the commit, delivered afterwards; same calendar entry.
    const [queued] = await db.select().from(notifications).where(eq(notifications.notification_id, notificationId));
    assert.equal(queued.status, "PENDING");

    assert.equal(await deliverNotification(notificationId), "SENT");
    const ics = mail.sent.at(-1)!.ics;
    assert.equal(prop(ics, "UID"), `UID:meeting-${m.meeting_id}@meetsched.local`);
    assert.equal(prop(ics, "SEQUENCE"), "SEQUENCE:1");
    assert.equal(prop(ics, "LOCATION"), "LOCATION:Beta");
  });

  it("an Admin may move it; anyone else may not (B-10)", async () => {
    const { meetings: [m] } = await createBooking(input());

    const denied = await failure(
      rescheduleMeeting({ meetingId: m.meeting_id, actor: carol(), roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "10:00", endTime: "11:00", notify: false })
    );
    assert.equal(denied.status, 403);

    // A group manager is not an Admin: still refused.
    const manager = { employeeId: f.users.manager.employeeId, role: "Manager" };
    assert.equal(
      (await failure(rescheduleMeeting({ meetingId: m.meeting_id, actor: manager, roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "10:00", endTime: "11:00", notify: false }))).status,
      403
    );

    await rescheduleMeeting({ meetingId: m.meeting_id, actor: admin(), roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "10:00", endTime: "11:00", notify: false });
    assert.equal((await row(m.meeting_id)).room_id, f.rooms.beta.room_id);
  });

  it("enforces duration, lead time, room policy and conflicts, leaving the meeting unchanged on refusal", async () => {
    const { meetings: [m] } = await createBooking(input());
    const before = await row(m.meeting_id);
    const move = (o: Partial<Parameters<typeof rescheduleMeeting>[0]>) =>
      rescheduleMeeting({ meetingId: m.meeting_id, actor: bob(), roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "10:00", endTime: "11:00", notify: false, ...o });

    assert.equal((await failure(move({ endTime: "10:14" }))).status, 400);

    const today = dateFromToday(0);
    const lead = await failure(
      move({ meetingDate: today, startTime: "15:10", endTime: "16:00", now: new Date(`${today}T09:30:00Z`) })
    ); // 15:00 IST "now"; 15:10 is only 10 minutes ahead
    assert.equal(lead.status, 400);
    assert.match(lead.message, /at least 15 minutes from now/);

    await db.insert(groupRooms).values({ groupId: f.groupIds.employee, roomId: f.rooms.alpha.room_id });
    assert.equal((await failure(move({}))).status, 403);
    await db.delete(groupRooms);

    await createBooking(input({ roomId: f.rooms.beta.room_id, occurrenceDates: [dateFromToday(8)], organizerEmployeeId: f.users.carol.employeeId, participantEmployeeIds: [], participantCount: 1 }));
    assert.equal((await failure(move({}))).status, 409);

    const now = await row(m.meeting_id);
    assert.deepEqual(
      [now.room_id, now.meeting_date, now.start_time, now.ics_sequence],
      [before.room_id, before.meeting_date, before.start_time, before.ics_sequence]
    );
    assert.equal((await notificationsFor([m.meeting_id])).filter((n) => n.status === "PENDING").length, 2, "only the booking's own rows");
  });

  it("can shift within its own slot (it never conflicts with itself)", async () => {
    const { meetings: [m] } = await createBooking(input());

    await rescheduleMeeting({ meetingId: m.meeting_id, actor: bob(), roomId: f.rooms.alpha.room_id, meetingDate: dateFromToday(7), startTime: "10:30", endTime: "11:30", notify: false });

    assert.equal((await row(m.meeting_id)).start_time, "10:30:00");
  });

  it("keeps the Teams event and link (no second event)", async () => {
    const { meetings: [m] } = await createBooking(input());
    await db
      .update(meeting)
      .set({
        online_requested: true,
        is_online: true,
        online_provider: "teams",
        online_event_id: "evt-1",
        online_join_url: "https://teams.microsoft.com/l/meetup-join/1",
      })
      .where(eq(meeting.meeting_id, m.meeting_id));

    await rescheduleMeeting({ meetingId: m.meeting_id, actor: bob(), roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "10:00", endTime: "11:00", notify: false });

    const after = await row(m.meeting_id);
    assert.equal(after.online_event_id, "evt-1");
    assert.equal(after.online_join_url, "https://teams.microsoft.com/l/meetup-join/1");
    assert.equal(after.is_online, true);
  });
});

describe("H-1: editing a series by scope", () => {
  it("this occurrence only", async () => {
    const { ids } = await weeklySeries();

    await editSeries({ meetingId: ids[1], scope: "single", actor: bob(), details: { title: "Standup (moved agenda)" }, notify: false });

    const titles = await Promise.all(ids.map(async (id) => (await row(id)).title));
    assert.deepEqual(titles, ["Standup", "Standup (moved agenda)", "Standup", "Standup"]);
  });

  it("this and following: earlier occurrences are untouched", async () => {
    const { ids } = await weeklySeries();

    const { changedMeetingIds } = await editSeries({ meetingId: ids[1], scope: "following", actor: bob(), details: { title: "Sprint review" }, notify: false });

    assert.deepEqual(changedMeetingIds.sort(), ids.slice(1).sort());
    assert.equal((await row(ids[0])).title, "Standup");
    for (const id of ids.slice(1)) assert.equal((await row(id)).title, "Sprint review");
  });

  it("entire series: a new time of day for every upcoming occurrence; answers kept, each entry versioned, history untouched", async () => {
    const { ids } = await weeklySeries();
    // The first occurrence is history (completed).
    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.COMPLETED }).where(eq(meeting.meeting_id, ids[0]));

    const { changedMeetingIds, notificationIds } = await editSeries({
      meetingId: ids[2],
      scope: "series",
      actor: bob(),
      slot: { startTime: "15:00", endTime: "15:30" },
      notify: false,
    });

    assert.deepEqual(changedMeetingIds.sort(), ids.slice(1).sort());
    assert.equal(notificationIds.length, 3, "one update per changed occurrence");

    const first = await row(ids[0]);
    assert.equal(first.start_time, "10:00:00", "completed occurrence untouched");
    assert.equal(first.meetingStatusId, MEETING_STATUS.COMPLETED);

    for (const id of ids.slice(1)) {
      const r = await row(id);
      assert.equal(r.start_time, "15:00:00");
      assert.equal(r.ics_sequence, 1);
    }

    const answers = await db.select().from(meeting_attendees).where(eq(meeting_attendees.employee_id, f.users.carol.employeeId));
    assert.ok(answers.every((a) => a.response_status === "ACCEPTED"));

    // Each update is its own REQUEST for its own entry.
    await deliverNotification(notificationIds[0]);
    const ics = mail.sent.at(-1)!.ics;
    assert.equal(prop(ics, "METHOD"), "METHOD:REQUEST");
    assert.match(prop(ics, "UID") ?? "", new RegExp(`^UID:meeting-(${ids.slice(1).join("|")})@`));
    assert.equal(prop(ics, "SEQUENCE"), "SEQUENCE:1");
  });

  it("a series move that conflicts on any date changes nothing", async () => {
    const { ids } = await weeklySeries();
    const { meetings: [blocker] } = await createBooking(
      input({ roomId: f.rooms.beta.room_id, occurrenceDates: [dateFromToday(21)], organizerEmployeeId: f.users.carol.employeeId, participantEmployeeIds: [], participantCount: 1 })
    );

    const err = await failure(editSeries({ meetingId: ids[0], scope: "series", actor: bob(), slot: { roomId: f.rooms.beta.room_id }, details: { title: "X" }, notify: false }));
    assert.equal(err.status, 409);

    for (const id of ids) {
      const r = await row(id);
      assert.deepEqual([r.room_id, r.title], [f.rooms.alpha.room_id, "Standup"]);
    }
    assert.equal((await row(blocker.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("only the organizer or an Admin (B-10)", async () => {
    const { ids } = await weeklySeries();

    assert.equal((await failure(editSeries({ meetingId: ids[0], scope: "series", actor: carol(), details: { title: "Hijack" } }))).status, 403);
    await editSeries({ meetingId: ids[0], scope: "series", actor: admin(), details: { title: "By admin" }, notify: false });
    assert.equal((await row(ids[3])).title, "By admin");
  });

  it("does not create Teams events: online occurrences keep theirs", async () => {
    const { ids } = await weeklySeries();
    for (const [i, id] of ids.entries()) {
      await db.update(meeting).set({ online_requested: true, is_online: true, online_provider: "teams", online_event_id: `evt-${i}`, online_join_url: `https://teams.microsoft.com/l/${i}` }).where(eq(meeting.meeting_id, id));
    }

    await editSeries({ meetingId: ids[0], scope: "series", actor: bob(), details: { title: "Renamed" }, slot: { startTime: "11:00", endTime: "11:30" }, notify: false });

    const events = (await rowsOf((await row(ids[0])).recurringMeetingId!)).map((r) => r.online_event_id);
    assert.deepEqual(events, ["evt-0", "evt-1", "evt-2", "evt-3"]);
  });
});

describe("H-1: cancelling by scope", () => {
  it("one occurrence only: the series continues", async () => {
    const { ids } = await weeklySeries();

    await cancelMeetings({ meetingId: ids[1], scope: "single", actor: bob(), notify: false });

    const statuses = await Promise.all(ids.map(async (id) => (await row(id)).meetingStatusId));
    assert.deepEqual(statuses, [1, MEETING_STATUS.CANCELLED, 1, 1]);
    assert.deepEqual((await notificationsFor([ids[1]])).filter((n) => n.status === "PENDING").length >= 1, true);
  });

  it("this and following: earlier occurrences stay", async () => {
    const { ids } = await weeklySeries();

    const { cancelledCount } = await cancelMeetings({ meetingId: ids[2], scope: "following", actor: bob(), notify: false });

    assert.equal(cancelledCount, 2);
    const statuses = await Promise.all(ids.map(async (id) => (await row(id)).meetingStatusId));
    assert.deepEqual(statuses, [1, 1, MEETING_STATUS.CANCELLED, MEETING_STATUS.CANCELLED]);
  });

  it("entire series: upcoming ones cancelled, history kept, each with its own calendar CANCEL", async () => {
    const { ids } = await weeklySeries();
    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.COMPLETED }).where(eq(meeting.meeting_id, ids[0]));

    const { notificationIds } = await cancelMeetings({ meetingId: ids[3], scope: "series", actor: bob(), notify: false });

    assert.equal(notificationIds.length, 3);
    assert.equal((await row(ids[0])).meetingStatusId, MEETING_STATUS.COMPLETED);
    for (const id of ids.slice(1)) assert.equal((await row(id)).meetingStatusId, MEETING_STATUS.CANCELLED);

    for (const n of notificationIds) await deliverNotification(n);
    const uids = mail.sent.map((m) => prop(m.ics, "UID")).sort();
    assert.deepEqual(uids, ids.slice(1).map((id) => `UID:meeting-${id}@meetsched.local`).sort());
    assert.ok(mail.sent.every((m) => prop(m.ics, "METHOD") === "METHOD:CANCEL" && prop(m.ics, "SEQUENCE") === "SEQUENCE:1"));
  });

  it("concurrent operations on one series never leave it half-changed", async () => {
    const { ids } = await weeklySeries();

    await Promise.allSettled([
      editSeries({ meetingId: ids[0], scope: "series", actor: bob(), details: { title: "Edited" }, notify: false }),
      cancelMeetings({ meetingId: ids[0], scope: "series", actor: bob(), notify: false }),
    ]);

    const rows = await Promise.all(ids.map(row));
    assert.equal(new Set(rows.map((r) => r.meetingStatusId)).size, 1, "all or none cancelled");
    assert.equal(new Set(rows.map((r) => r.title)).size, 1, "all or none renamed");
  });
});

describe("L-1 / L-2: pattern, skipped dates and end date", () => {
  it("every 2 weeks, with an inclusive end-by date", async () => {
    const start = dateFromToday(7);
    const end = dateFromToday(7 + 28);
    const { seriesId } = await weeklySeries({ interval: 2, end_date: end, occurrence_count: undefined });

    assert.deepEqual(
      (await rowsOf(seriesId)).map((r) => r.meeting_date),
      [start, dateFromToday(21), end]
    );

    const [series] = await db.select().from(recurring_meetings).where(eq(recurring_meetings.recurring_meeting_id, seriesId));
    assert.deepEqual([series.recurrence_interval, series.until_date, series.pattern_start_date], [2, end, start]);
  });

  it("refuses an interval for non-weekly series, an end before the start, and too many occurrences", async () => {
    assert.equal(
      (await failure(weeklySeries({ frequency_id: await frequencyId("MONTHLY"), interval: 2 }))).status,
      400
    );
    assert.equal((await failure(weeklySeries({ end_date: dateFromToday(1), occurrence_count: undefined }))).status, 400);
    assert.match(
      (await failure(weeklySeries({ end_date: dateFromToday(7 + 7 * 20), occurrence_count: undefined }))).message,
      /more than 12 occurrences/
    );
  });

  it("skipped dates are stored with the series, listed in its e-mail, and never re-created", async () => {
    const skip = dateFromToday(14);
    const { seriesId, ids } = await weeklySeries({ skip_dates: [skip] });

    const stored = await db.select().from(recurringMeetingSkippedDates).where(eq(recurringMeetingSkippedDates.recurringMeetingId, seriesId));
    assert.deepEqual(stored.map((s) => s.skippedDate), [skip]);

    assert.deepEqual((await loadSeriesEmailContext(db, seriesId))!.series.skippedDates, [skip]);

    // Editing the series keeps the exception.
    await editSeries({ meetingId: ids[0], scope: "series", actor: bob(), details: { title: "Renamed" }, notify: false });

    // Extending it books the later pattern dates, but not the skipped one.
    await changeSeriesEnd({ meetingId: ids[0], endDate: dateFromToday(7 + 7 * 5), actor: bob(), notify: false });

    const dates = (await rowsOf(seriesId)).map((r) => r.meeting_date);
    assert.ok(!dates.includes(skip), "the skipped date was not re-created");
    assert.equal(new Set(dates).size, dates.length, "no duplicates");
    assert.ok(dates.includes(dateFromToday(7 + 7 * 5)));

    const details = await getSeriesDetails(ids[0], bob());
    assert.deepEqual(details.skippedDates, [skip]);
  });

  it("extending copies the latest occurrence and the answers already given", async () => {
    const { seriesId, ids } = await weeklySeries();

    const { addedMeetingIds } = await changeSeriesEnd({ meetingId: ids[0], endDate: dateFromToday(7 + 7 * 5), actor: bob(), notify: false });

    assert.equal(addedMeetingIds.length, 2);
    for (const id of addedMeetingIds) {
      const r = await row(id);
      assert.equal(r.recurringMeetingId, seriesId);
      assert.equal(r.title, "Standup");

      const [answer] = await db
        .select()
        .from(meeting_attendees)
        .where(and(eq(meeting_attendees.meeting_id, id), eq(meeting_attendees.employee_id, f.users.carol.employeeId)));
      assert.equal(answer.response_status, "ACCEPTED");
    }
  });

  it("shortening cancels only upcoming occurrences after the new end date", async () => {
    const { ids } = await weeklySeries();

    const { cancelledCount } = await changeSeriesEnd({ meetingId: ids[0], endDate: dateFromToday(14), actor: bob(), notify: false });

    assert.equal(cancelledCount, 2);
    const statuses = await Promise.all(ids.map(async (id) => (await row(id)).meetingStatusId));
    assert.deepEqual(statuses, [1, 1, MEETING_STATUS.CANCELLED, MEETING_STATUS.CANCELLED]);
  });

  it("existing series stored before the pattern columns still work", async () => {
    const { seriesId, ids } = await weeklySeries();
    await db.update(recurring_meetings).set({ pattern_start_date: null }).where(eq(recurring_meetings.recurring_meeting_id, seriesId));

    const details = await getSeriesDetails(ids[0], bob());
    assert.equal(details.patternStartDate, dateFromToday(7));
    assert.equal(details.frequency, "WEEKLY");
  });
});

describe("approved decisions", () => {
  it("B-05: a 12-month monthly series is allowed when its first date is inside the 3-month window", async () => {
    const { meetings } = await createRecurringMeeting({
      title: "Monthly review",
      room_id: f.rooms.alpha.room_id,
      meeting_date: dateFromToday(10),
      start_time: "09:00",
      end_time: "10:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 1,
      meetingTypeId: f.types.team,
      frequency_id: await frequencyId("MONTHLY"),
      occurrence_count: 12,
      notify: false,
    });

    assert.equal(meetings.length, 12);
    assert.ok(meetings.some((m) => m.meeting_date > dateFromToday(300)), "runs ~11 months ahead");
  });

  it("B-09: the server refuses a meeting starting less than 15 minutes from now, and accepts 15", async () => {
    const today = dateFromToday(0);
    const now = new Date(`${today}T04:30:00Z`); // 10:00 IST

    const soon = await failure(createBooking(input({ occurrenceDates: [today], startTime: "10:10", endTime: "10:40", now })));
    assert.equal(soon.status, 400);
    assert.match(soon.message, /at least 15 minutes from now/);

    const { meetings } = await createBooking(input({ occurrenceDates: [today], startTime: "10:15", endTime: "10:45", now }));
    assert.equal(meetings.length, 1);
    assert.equal(nowInAppTimezone(now).time.slice(0, 5), "10:00");
  });

  it("B-10: there is no separate edit permission", () => {
    assert.ok(!Object.values(PERMISSION).some((p) => /edit/i.test(p)));
  });
});

