import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  meeting,
  meeting_audit_logs,
  notifications,
  recurrence_frequency_master,
  reschedule_requests,
} from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import { deliverNotification } from "@/lib/services/notification.service";
import {
  ONLINE_MAX_ATTEMPTS,
  OnlineMeetingError,
  adminRetryOnlineMeeting,
  cleanupOnlineMeetings,
  listOnlineProvisioning,
  processOnlineMeetings,
  retryOnlineMeetings,
  setOnlineDispatchEnabled,
} from "@/lib/services/online-meeting.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { bumpDeadline, processExpiredBumps } from "@/lib/services/priority.service";
import { rescheduleMeeting } from "@/lib/services/reschedule.service";
import { cancelMeetings, changeSeriesEnd, editSeries } from "@/lib/services/series.service";
import {
  setTeamsProvider,
  TeamsError,
  type OnlineMeetingSlot,
  type TeamsMeetingProvider,
} from "@/lib/services/teams-meeting.service";

import {
  captureMail,
  dateFromToday,
  minutesFromNow,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

// Phase 5: Teams provisioning in the background (M-2, M-3), Graph failures,
// e-mails that wait for the link, lifecycle sync, admin retry. Graph is faked.

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

const joinUrlFor = (transactionId: string) =>
  `https://teams.microsoft.com/l/meetup-join/${transactionId}`;

// A stand-in for Microsoft Graph. Like Graph, a repeated transactionId returns
// the same event instead of a new one.
function fakeTeams(
  options: {
    failCreate?: (callNumber: number, slot: OnlineMeetingSlot) => Error | false;
    joinUrl?: (transactionId: string) => string;
    failDeleteTimes?: number;
    failUpdate?: () => Error | false;
    onCreate?: () => Promise<void>;
  } = {}
) {
  const created = new Map<string, { eventId: string; joinUrl: string }>();
  const calls = {
    create: [] as { slot: OnlineMeetingSlot; transactionId: string }[],
    update: [] as { eventId: string; slot: OnlineMeetingSlot }[],
    delete: [] as string[],
  };
  let failDeletes = options.failDeleteTimes ?? 0;

  const provider: TeamsMeetingProvider = {
    async createEvent(slot, transactionId) {
      calls.create.push({ slot, transactionId });
      await options.onCreate?.();

      const failure = options.failCreate?.(calls.create.length, slot);
      if (failure) throw failure;

      const existing = created.get(transactionId);
      if (existing) return existing;

      const event = {
        eventId: `EVT-${transactionId}`,
        joinUrl: (options.joinUrl ?? joinUrlFor)(transactionId),
      };
      created.set(transactionId, event);

      return event;
    },
    async updateEvent(eventId, slot) {
      calls.update.push({ eventId, slot });

      const failure = options.failUpdate?.();
      if (failure) throw failure;
    },
    async deleteEvent(eventId) {
      calls.delete.push(eventId);

      if (failDeletes > 0) {
        failDeletes--;
        throw new TeamsError("Microsoft could not cancel the Teams meeting (HTTP 503).", "GRAPH", 503);
      }
    },
  };

  return { provider, calls };
}

const throttled = (retryAfterMs?: number) =>
  new TeamsError("Microsoft is busy right now.", "THROTTLED", 429, { retryAfterMs });
const forbidden = () =>
  new TeamsError("The Teams app is not permitted to create the Teams meeting in the organizer mailbox.", "PERMISSION", 403);

before(async () => {
  f = await seedFixtures();
  setOnlineDispatchEnabled(false);
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE booking_priority_history, meeting_audit_logs, reminder_logs,
      notifications, reschedule_requests, meeting_attendees, meeting,
      recurring_meetings
    RESTART IDENTITY CASCADE
  `);
  mail = captureMail();
});

after(() => {
  setTeamsProvider(null);
  setOnlineDispatchEnabled(true);
  mail?.restore();
});

const DAY = () => dateFromToday(7);

// Bob organizes; Carol is a required participant and Dave an optional one.
function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Planning",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [DAY()],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 3,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [f.users.carol.employeeId],
    optionalParticipantEmployeeIds: [f.users.dave.employeeId],
    notify: false,
    ...overrides,
  };
}

const bob = () => ({ employeeId: f.users.bob.employeeId, role: "Employee" });

const row = async (id: number) =>
  (await db.select().from(meeting).where(eq(meeting.meeting_id, id)))[0];

// Runs the worker until it has nothing due (at `now`, default: real time).
async function work(now?: Date) {
  const total = { READY: 0, STALE: 0, RETRY: 0, FAILED: 0, SKIPPED: 0 };

  for (let i = 0; i < 20; i++) {
    const s = await processOnlineMeetings({ now });
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
    if (Object.values(s).every((v) => v === 0)) break;
  }

  return total;
}

// Delivers every PENDING notification that is due; returns their results.
async function deliverDue(now?: Date) {
  const rows = await db.select().from(notifications).where(eq(notifications.status, "PENDING"));
  const results = [];
  for (const n of rows) results.push(await deliverNotification(n.notification_id, now));
  return results;
}

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
const prop = (ics: string, name: string) =>
  unfold(ics).split("\r\n").find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

describe("a normal meeting", () => {
  it("is booked exactly as before: no Teams call, status NONE, e-mails queued with the booking", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    const result = await createBooking(input());
    const saved = await row(result.meetings[0].meeting_id);

    assert.equal(result.online, undefined);
    assert.equal(saved.online_requested, false);
    assert.equal(saved.online_status, "NONE");
    assert.equal(saved.is_online, false);

    assert.equal((await work()).READY, 0);
    assert.equal(teams.calls.create.length, 0);
    assert.equal((await db.select().from(notifications)).length, 3);
  });

  it("sends e-mails with no Teams content, without waiting", async () => {
    setTeamsProvider(fakeTeams().provider);

    await createBooking(input());

    assert.deepEqual(await deliverDue(), ["SENT", "SENT", "SENT"]);
    for (const m of mail.sent) assert.doesNotMatch(m.html + m.text + m.ics, /Teams|Join Meeting/);
  });
});

describe("booking an online meeting (M-2, M-3)", () => {
  it("never calls Microsoft during the booking: the occurrence is PENDING and the e-mails are queued with it", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    const result = await createBooking(input({ online: true }));
    const saved = await row(result.meetings[0].meeting_id);

    assert.deepEqual(result.online, { requested: true, pending: 1, created: 0, failed: 0 });
    assert.equal(teams.calls.create.length, 0);
    assert.deepEqual([saved.online_status, saved.is_online, saved.online_event_id], ["PENDING", false, null]);
    assert.equal(result.invitationNotificationIds.length, 2);
    assert.equal((await db.select().from(notifications)).length, 3, "queued in the booking transaction");
  });

  it("the worker creates the event, stores it and marks READY", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));

    assert.equal((await work()).READY, 1);

    const saved = await row(m.meeting_id);
    assert.equal(saved.online_status, "READY");
    assert.equal(saved.is_online, true);
    assert.equal(saved.online_event_id, `EVT-sched-meeting-${m.meeting_id}`);
    assert.equal(saved.online_join_url, joinUrlFor(`sched-meeting-${m.meeting_id}`));
    assert.ok(saved.online_synced_at);
    assert.equal(saved.online_attempts, 0);

    assert.equal(teams.calls.create.length, 1);
    assert.deepEqual(
      [teams.calls.create[0].slot.title, teams.calls.create[0].slot.meetingDate, teams.calls.create[0].slot.roomName],
      ["Planning", DAY(), "Alpha"]
    );
  });

  it("holds the confirmation and invitations while PENDING, then sends them with the link and calendar entry", async () => {
    setTeamsProvider(fakeTeams().provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));

    assert.deepEqual(await deliverDue(), ["SKIPPED", "SKIPPED", "SKIPPED"]);
    assert.equal(mail.sent.length, 0);

    const waiting = await db.select().from(notifications);
    assert.ok(waiting.every((n) => n.status === "PENDING" && n.attempts === 0), "waiting uses no attempt");
    assert.match(waiting[0].last_error ?? "", /Waiting for the Microsoft Teams link/);

    await work();
    assert.deepEqual(await deliverDue(minutesFromNow(1)), ["SENT", "SENT", "SENT"]);

    const url = joinUrlFor(`sched-meeting-${m.meeting_id}`);
    for (const message of mail.sent) {
      assert.ok(message.text.includes(url), message.subject);
      assert.ok(prop(message.ics, "URL")?.endsWith(url));
      assert.ok(prop(message.ics, "DESCRIPTION")?.includes(url));
      assert.equal(prop(message.ics, "UID"), `UID:meeting-${m.meeting_id}@meetsched.local`);
    }
  });

  it("an invalid joining link is never stored (FAILED, not online)", async () => {
    setTeamsProvider(fakeTeams({ joinUrl: () => "https://teams.evil.example/x" }).provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    await work();

    const saved = await row(m.meeting_id);
    assert.deepEqual([saved.online_status, saved.is_online, saved.online_join_url], ["FAILED", false, null]);
  });

  it("is protected by the database: no online flag without link and event id, one event per meeting", async () => {
    const { meetings: [a] } = await createBooking(input());
    const { meetings: [b] } = await createBooking(input({ startTime: "12:00", endTime: "13:00" }));

    await assert.rejects(db.update(meeting).set({ is_online: true }).where(eq(meeting.meeting_id, a.meeting_id)));

    const online = { is_online: true, online_provider: "MICROSOFT_TEAMS", online_join_url: joinUrlFor("x"), online_event_id: "SAME" };
    await db.update(meeting).set(online).where(eq(meeting.meeting_id, a.meeting_id));
    await assert.rejects(db.update(meeting).set(online).where(eq(meeting.meeting_id, b.meeting_id)));
    await assert.rejects(db.update(meeting).set({ online_status: "MAYBE" }).where(eq(meeting.meeting_id, a.meeting_id)));
  });
});

describe("when Microsoft fails", () => {
  it("throttling is retried after Retry-After, then succeeds", async () => {
    let calls = 0;
    const teams = fakeTeams({ failCreate: () => (++calls === 1 ? throttled(120_000) : false) });
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    const t0 = minutesFromNow(0);

    assert.equal((await processOnlineMeetings({ now: t0 })).RETRY, 1);

    let saved = await row(m.meeting_id);
    assert.equal(saved.online_status, "PENDING");
    assert.equal(saved.online_attempts, 1);
    assert.ok(Math.abs(saved.online_next_attempt_at!.getTime() - (t0.getTime() + 120_000)) < 2000, "Retry-After respected");
    assert.match(saved.online_last_error ?? "", /busy/);

    assert.equal((await processOnlineMeetings({ now: minutesFromNow(1) })).RETRY, 0, "not before Retry-After");
    assert.equal((await processOnlineMeetings({ now: minutesFromNow(3) })).READY, 1);

    saved = await row(m.meeting_id);
    assert.deepEqual([saved.online_status, saved.online_last_error], ["READY", null]);
  });

  it("gives up after the attempt limit: FAILED, recorded, and the e-mails go out without a link", async () => {
    setTeamsProvider(fakeTeams({ failCreate: () => throttled() }).provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));

    for (let i = 0; i < ONLINE_MAX_ATTEMPTS; i++) await processOnlineMeetings({ now: minutesFromNow(60 * (i + 1)) });

    const saved = await row(m.meeting_id);
    assert.deepEqual([saved.online_status, saved.online_attempts], ["FAILED", ONLINE_MAX_ATTEMPTS]);

    const audit = await db.select().from(meeting_audit_logs);
    assert.ok(audit.some((a) => a.action === "ONLINE_MEETING_CREATE_FAILED"));

    assert.deepEqual(await deliverDue(), ["SENT", "SENT", "SENT"], "the fallback: no link, but no waiting either");
    for (const message of mail.sent) assert.doesNotMatch(message.html + message.text, /Join Meeting/);
  });

  it("a permanent error (permission) fails at once, without retrying", async () => {
    const teams = fakeTeams({ failCreate: () => forbidden() });
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    assert.equal((await work(minutesFromNow(600))).FAILED, 1);

    assert.equal((await row(m.meeting_id)).online_status, "FAILED");
    assert.equal(teams.calls.create.length, 1);
  });

  it("a missing configuration is FAILED with a readable reason", async () => {
    setTeamsProvider(null);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    await work();

    const saved = await row(m.meeting_id);
    assert.equal(saved.online_status, "FAILED");
    assert.match(saved.online_last_error ?? "", /not configured/);
  });

  it("e-mails wait no longer than the configured limit", async () => {
    setTeamsProvider(fakeTeams({ failCreate: () => throttled() }).provider);
    const saved = process.env.ONLINE_INVITE_MAX_WAIT_MINUTES;
    process.env.ONLINE_INVITE_MAX_WAIT_MINUTES = "0";

    try {
      await createBooking(input({ online: true }));
      assert.deepEqual(await deliverDue(minutesFromNow(1)), ["SENT", "SENT", "SENT"]);
    } finally {
      if (saved === undefined) delete process.env.ONLINE_INVITE_MAX_WAIT_MINUTES;
      else process.env.ONLINE_INVITE_MAX_WAIT_MINUTES = saved;
    }
  });
});

describe("retry, concurrency and stale work", () => {
  it("a late link after the fallback e-mails reaches everyone as an update with a new calendar version", async () => {
    let healthy = false;
    const teams = fakeTeams({ failCreate: () => (healthy ? false : forbidden()) });
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    await work();
    await deliverDue();
    assert.equal(mail.sent.length, 3);

    healthy = true;
    assert.deepEqual(await retryOnlineMeetings(m.meeting_id, bob()), { requested: true, pending: 1, created: 0, failed: 0 });
    await work();

    const saved = await row(m.meeting_id);
    assert.deepEqual([saved.online_status, saved.ics_sequence], ["READY", 1]);

    await deliverDue();
    const update = mail.sent.at(-1)!;
    assert.match(update.subject, /Updated/);
    const url = joinUrlFor(`sched-meeting-${m.meeting_id}`);
    assert.ok(update.text.includes(url));
    assert.equal(prop(update.ics, "SEQUENCE"), "SEQUENCE:1");
    assert.ok(prop(update.ics, "DESCRIPTION")?.includes(url));

    // Nothing left to retry; running the worker again changes nothing.
    await assert.rejects(retryOnlineMeetings(m.meeting_id, bob()), (e: OnlineMeetingError) => e.status === 409);
    await work(minutesFromNow(60));
    assert.equal((await row(m.meeting_id)).ics_sequence, 1, "no version for a retry without a change");
    assert.equal(teams.calls.create.length, 2);
  });

  it("only the organizer or an Admin may retry, and only when Teams was requested", async () => {
    setTeamsProvider(fakeTeams({ failCreate: () => forbidden() }).provider);

    const online = await createBooking(input({ online: true }));
    const plain = await createBooking(input({ startTime: "12:00", endTime: "13:00" }));
    await work();

    const id = online.meetings[0].meeting_id;
    await assert.rejects(
      retryOnlineMeetings(id, { employeeId: f.users.carol.employeeId, role: "Employee" }),
      (e: OnlineMeetingError) => e.status === 403
    );
    await assert.rejects(retryOnlineMeetings(plain.meetings[0].meeting_id, bob()), (e: OnlineMeetingError) => e.status === 400);

    const byAdmin = await retryOnlineMeetings(id, { employeeId: f.users.admin.employeeId, role: "Admin" });
    assert.equal(byAdmin.pending, 1);
  });

  it("two workers never provision the same occurrence", async () => {
    const teams = fakeTeams({ onCreate: () => new Promise((r) => setTimeout(r, 300)) });
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));

    await Promise.all([processOnlineMeetings(), processOnlineMeetings(), processOnlineMeetings()]);

    assert.equal(teams.calls.create.length, 1);
    assert.equal((await row(m.meeting_id)).online_status, "READY");
  });

  it("a worker that died mid-call: its lease expires and the work is redone without a duplicate event", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));

    // The dead worker had claimed it (attempt 1) and Graph had created the event.
    await teams.provider.createEvent({ title: "Planning", meetingDate: DAY(), startTime: "10:00", endTime: "11:00" }, `sched-meeting-${m.meeting_id}`);
    await db
      .update(meeting)
      .set({ online_attempts: 1, online_locked_until: minutesFromNow(2) })
      .where(eq(meeting.meeting_id, m.meeting_id));

    assert.equal((await work()).READY, 0, "lease still running: left alone");
    assert.equal((await work(minutesFromNow(3))).READY, 1);

    const saved = await row(m.meeting_id);
    assert.equal(saved.online_event_id, `EVT-sched-meeting-${m.meeting_id}`, "Graph returned the same event");
  });

  it("a change while the worker is busy is not lost: stale work leaves the row PENDING for the next round", async () => {
    let renameDuringCreate = true;
    let id = 0;
    const teams = fakeTeams({
      onCreate: async () => {
        if (!renameDuringCreate) return;
        renameDuringCreate = false;
        await editSeries({ meetingId: id, scope: "single", actor: bob(), details: { title: "Renamed" }, notify: false });
      },
    });
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    id = m.meeting_id;

    // The first round's result is stale (it created the event for the old
    // title): stored, but left PENDING; the worker picks it up again at once
    // and pushes the new title.
    const summary = await processOnlineMeetings();
    assert.deepEqual([summary.STALE, summary.READY], [1, 1]);

    assert.equal(teams.calls.create.length, 1);
    assert.equal(teams.calls.update.at(-1)!.slot.title, "Renamed");
    assert.equal((await row(id)).online_status, "READY");
  });
});

describe("lifecycle: moves, edits, cancellation", () => {
  async function readyMeeting(teams = fakeTeams()) {
    setTeamsProvider(teams.provider);
    const { meetings: [m] } = await createBooking(input({ online: true }));
    await work();
    return { teams, id: m.meeting_id, before: await row(m.meeting_id) };
  }

  it("moving a meeting updates the same event (new room, date, time); the link stays", async () => {
    const { teams, id, before } = await readyMeeting();

    await rescheduleMeeting({ meetingId: id, actor: bob(), roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "14:00", endTime: "15:00", notify: false });

    assert.equal((await row(id)).online_status, "PENDING", "marked in the move's transaction");
    assert.equal(teams.calls.update.length, 0, "no Graph call during the move");

    await work();

    assert.equal(teams.calls.create.length, 1, "no second event");
    const update = teams.calls.update[0];
    assert.equal(update.eventId, before.online_event_id);
    assert.deepEqual([update.slot.meetingDate, update.slot.roomName], [dateFromToday(8), "Beta"]);
    assert.match(update.slot.startTime, /^14:00/);

    const after = await row(id);
    assert.deepEqual([after.online_status, after.online_join_url], ["READY", before.online_join_url]);
  });

  it("the move stands while Microsoft is unavailable; the update is retried", async () => {
    let down = true;
    const { teams, id } = await readyMeeting(fakeTeams({ failUpdate: () => (down ? new TeamsError("Microsoft could not update the Teams meeting (HTTP 503).", "GRAPH", 503) : false) }));

    await rescheduleMeeting({ meetingId: id, actor: bob(), roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "14:00", endTime: "15:00", notify: false });
    await processOnlineMeetings();

    let saved = await row(id);
    assert.deepEqual([saved.meeting_date, saved.online_status], [dateFromToday(8), "PENDING"]);
    assert.match(saved.online_last_error ?? "", /503/);

    down = false;
    await work(minutesFromNow(60));
    saved = await row(id);
    assert.equal(saved.online_status, "READY");
    assert.equal(teams.calls.update.length, 2);
  });

  it("a renamed meeting is pushed to its event; a normal meeting causes no Graph call", async () => {
    const { teams, id } = await readyMeeting();
    const { meetings: [plain] } = await createBooking(input({ startTime: "15:00", endTime: "16:00" }));

    await editSeries({ meetingId: id, scope: "single", actor: bob(), details: { title: "Renamed" }, notify: false });
    await editSeries({ meetingId: plain.meeting_id, scope: "single", actor: bob(), details: { title: "Also renamed" }, notify: false });
    await work();

    assert.deepEqual(teams.calls.update.map((u) => u.slot.title), ["Renamed"]);
  });

  it("an event deleted in Outlook is re-created instead of failing forever", async () => {
    let gone = true;
    const { teams, id } = await readyMeeting(fakeTeams({ failUpdate: () => (gone ? new TeamsError("The organizer mailbox or the calendar event was not found.", "NOT_FOUND", 404) : false) }));

    gone = true;
    await editSeries({ meetingId: id, scope: "single", actor: bob(), details: { title: "Renamed" }, notify: false });
    await work();

    const saved = await row(id);
    assert.equal(saved.online_status, "READY");
    assert.equal(teams.calls.create.length, 2, "re-created");
  });

  it("cancellation removes the event once (an already deleted one counts as deleted)", async () => {
    const { teams, id, before } = await readyMeeting();

    assert.equal(await cleanupOnlineMeetings(), 0, "scheduled meetings are left alone");

    await cancelMeetings({ meetingId: id, scope: "single", actor: bob(), notify: false });
    assert.equal(await cleanupOnlineMeetings(), 1);
    assert.deepEqual(teams.calls.delete, [before.online_event_id]);

    const saved = await row(id);
    assert.deepEqual([saved.is_online, saved.online_event_id, saved.online_status], [false, null, "NONE"]);
    assert.equal(await cleanupOnlineMeetings(), 0);
  });

  it("a failed delete is recorded and retried with backoff", async () => {
    const { teams, id } = await readyMeeting(fakeTeams({ failDeleteTimes: 1 }));
    await cancelMeetings({ meetingId: id, scope: "single", actor: bob(), notify: false });

    assert.equal(await cleanupOnlineMeetings(), 0);
    const saved = await row(id);
    assert.ok(saved.online_event_id, "still recorded for the retry");
    assert.match(saved.online_last_error ?? "", /503/);

    assert.equal(await cleanupOnlineMeetings(), 0, "not before its backoff");
    assert.equal(await cleanupOnlineMeetings(50, minutesFromNow(60)), 1);
    assert.equal(teams.calls.delete.length, 2);
  });

  it("a meeting cancelled before its event was created never gets one, nor a stale invitation", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    await cancelMeetings({ meetingId: m.meeting_id, scope: "single", actor: bob(), notify: false });

    await work();
    assert.equal(teams.calls.create.length, 0);

    await cleanupOnlineMeetings();
    assert.equal((await row(m.meeting_id)).online_status, "NONE");

    const results = await deliverDue();
    assert.ok(mail.sent.every((x) => /Cancelled/.test(x.subject)), "only the cancellation goes out");
    assert.ok(results.includes("SKIPPED"));
  });

  it("removes the event of a booking taken over by a higher-priority meeting type, and of an expired bump", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    const { meetings: [low] } = await createBooking(input({ online: true, meetingTypeId: f.types.others }));
    await work();
    const eventId = (await row(low.meeting_id)).online_event_id!;

    await createBooking(input({ title: "Manager meeting", organizerEmployeeId: f.users.manager.employeeId, participantCount: 1, participantEmployeeIds: [], optionalParticipantEmployeeIds: [] }));
    assert.equal((await row(low.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);

    await cleanupOnlineMeetings();
    assert.ok(teams.calls.delete.includes(eventId));

    // An expired bump (legacy engine).
    const { meetings: [other] } = await createBooking(input({ online: true, startTime: "15:00", endTime: "16:00" }));
    await work();
    const otherEvent = (await row(other.meeting_id)).online_event_id!;
    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.PENDING_RESCHEDULE }).where(eq(meeting.meeting_id, other.meeting_id));
    await db.insert(reschedule_requests).values({ bumped_meeting_id: other.meeting_id, claimant_meeting_id: low.meeting_id, status: "PENDING", deadline: bumpDeadline(DAY(), "15:00") });

    assert.equal(await processExpiredBumps(new Date(bumpDeadline(DAY(), "15:00").getTime() + 60_000)), 1);
    await cleanupOnlineMeetings();
    assert.ok(teams.calls.delete.includes(otherEvent));
  });
});

describe("recurring series", () => {
  const weeklyId = async () =>
    (await db.select().from(recurrence_frequency_master).where(eq(recurrence_frequency_master.frequency_name, "WEEKLY")))[0].frequency_id;

  const series = async (overrides = {}) => ({
    title: "Standup",
    room_id: f.rooms.alpha.room_id,
    meeting_date: DAY(),
    start_time: "10:00",
    end_time: "10:30",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 3,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [f.users.carol.employeeId],
    optionalParticipantEmployeeIds: [f.users.dave.employeeId],
    frequency_id: await weeklyId(),
    occurrence_count: 3,
    online: true,
    notify: false,
    ...overrides,
  });

  const occurrences = async () =>
    (await db.select().from(meeting)).sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));

  it("gets one event per occurrence; the series e-mails wait for all of them and list every link", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    const result = await createRecurringMeeting(await series());
    assert.equal(result.online?.pending, 3);

    assert.deepEqual(await deliverDue(), ["SKIPPED", "SKIPPED", "SKIPPED"], "confirmation and both invitations wait");

    assert.equal((await work()).READY, 3);
    const rows = await occurrences();
    assert.equal(new Set(rows.map((r) => r.online_event_id)).size, 3);

    await deliverDue(minutesFromNow(1));
    for (const m of mail.sent) {
      for (const r of rows) assert.ok(m.text.includes(r.online_join_url!), m.subject);
    }
  });

  it("one occurrence failing does not hold the others; a retry re-does only that one", async () => {
    const teams = fakeTeams({ failCreate: (n) => (n === 2 ? forbidden() : false) });
    setTeamsProvider(teams.provider);

    await createRecurringMeeting(await series());
    await work();

    let rows = await occurrences();
    assert.deepEqual(rows.map((r) => r.online_status).sort(), ["FAILED", "READY", "READY"]);

    const failed = rows.find((r) => r.online_status === "FAILED")!;
    await retryOnlineMeetings(failed.meeting_id, bob());
    await work();

    rows = await occurrences();
    assert.ok(rows.every((r) => r.online_status === "READY"));
    assert.equal(teams.calls.create.length, 4, "3 + the one retry");
  });

  it("a series edit updates only the affected occurrences; extending provisions only the new ones", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    await createRecurringMeeting(await series());
    await work();
    const rows = await occurrences();

    await editSeries({ meetingId: rows[1].meeting_id, scope: "following", actor: bob(), details: { title: "Later" }, notify: false });
    await work();
    assert.deepEqual(teams.calls.update.map((u) => u.eventId).sort(), [rows[1].online_event_id, rows[2].online_event_id].sort());

    await changeSeriesEnd({ meetingId: rows[0].meeting_id, endDate: dateFromToday(7 + 7 * 4), actor: bob(), notify: false });
    await work();

    const after = await occurrences();
    assert.equal(after.length, 5);
    assert.equal(teams.calls.create.length, 5, "only the 2 new occurrences were created");
    assert.ok(after.every((r) => r.online_status === "READY"));
  });

  it("cancelling the series removes every event", async () => {
    const teams = fakeTeams();
    setTeamsProvider(teams.provider);

    await createRecurringMeeting(await series());
    await work();
    const rows = await occurrences();

    await cancelMeetings({ meetingId: rows[0].meeting_id, scope: "series", actor: bob(), notify: false });
    await cleanupOnlineMeetings();

    assert.deepEqual(teams.calls.delete.sort(), rows.map((r) => r.online_event_id!).sort());
  });
});

describe("administration", () => {
  it("lists FAILED provisioning with its reason and retry timing; an admin retry queues it again", async () => {
    setTeamsProvider(fakeTeams({ failCreate: () => forbidden() }).provider);

    const { meetings: [m] } = await createBooking(input({ online: true }));
    await work();

    const list = await listOnlineProvisioning();
    assert.equal(list.counts.FAILED, 1);
    const [record] = list.records;
    assert.equal(record.meetingId, m.meeting_id);
    assert.equal(record.status, "FAILED");
    assert.equal(record.attempts, 1);
    assert.match(record.lastError ?? "", /not permitted/);

    setTeamsProvider(fakeTeams().provider);
    assert.deepEqual(await adminRetryOnlineMeeting(m.meeting_id, f.users.admin.employeeId), { queued: 1 });
    assert.equal((await row(m.meeting_id)).online_status, "PENDING");

    // Not FAILED any more: nothing to retry (never races the worker).
    await assert.rejects(adminRetryOnlineMeeting(m.meeting_id, f.users.admin.employeeId), (e: OnlineMeetingError) => e.status === 404);

    await work();
    assert.equal((await row(m.meeting_id)).online_status, "READY");
  });
});
