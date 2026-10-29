import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  meeting,
  meeting_audit_logs,
  notification_type_master,
  notifications,
  reminder_logs,
} from "@/db/schema";
import { MEETING_STATUS, REMINDER_LEAD_MINUTES } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  type BookingInput,
} from "@/lib/services/booking.service";
import { updateCompletedMeetings } from "@/lib/services/meeting-status.service";
import {
  deliverNotification,
  processPendingNotifications,
} from "@/lib/services/notification.service";
import {
  createRemindersForMeetings,
  processDueReminders,
} from "@/lib/services/reminder.service";
import { runReminderTick } from "@/lib/cron/reminder-job";
import { nowInAppTimezone } from "@/lib/time";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

before(async () => {
  f = await seedFixtures();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE meeting_audit_logs, reminder_logs, notifications,
      meeting_attendees, meeting, recurring_meetings RESTART IDENTITY CASCADE
  `);
  mail = captureMail();
});

after(() => mail?.restore());

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

const makeDue = (meetingId: number) =>
  db
    .update(reminder_logs)
    .set({ reminder_time: new Date(Date.now() - 60_000) })
    .where(eq(reminder_logs.meeting_id, meetingId));

const waitFor = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe("records are created by the booking itself (F-15)", () => {
  it("writes a reminder, an audit row and a pending notification with the booking", async () => {
    const { meetings } = await createBooking(input());
    const id = meetings[0].meeting_id;

    const [reminder] = await db.select().from(reminder_logs);
    assert.equal(reminder.meeting_id, id);
    assert.equal(reminder.status, "PENDING");
    assert.equal(reminder.attempts, 0);

    // due LEAD minutes before the meeting starts (10:00 IST, 7 days out)
    const expected = await db.execute(sql`
      SELECT ((meeting_date + start_time) AT TIME ZONE 'Asia/Kolkata')
             - make_interval(mins => ${REMINDER_LEAD_MINUTES}) AS due
      FROM meeting WHERE meeting_id = ${id}`);
    assert.equal(
      reminder.reminder_time.getTime(),
      new Date(expected.rows[0].due as string).getTime()
    );

    const [audit] = await db.select().from(meeting_audit_logs);
    assert.equal(audit.action, "MEETING_CREATED");
    assert.equal(audit.meeting_id, id);
    assert.equal(audit.actor_employee_id, f.users.bob.employeeId);

    const [n] = await db.select().from(notifications);
    assert.equal(n.meeting_id, id);
    assert.equal(n.status, "PENDING");

    const [type] = await db
      .select()
      .from(notification_type_master)
      .where(eq(notification_type_master.notification_type_id, n.notification_type_id));
    assert.equal(type.notification_type_name, "MEETING_BOOKED");
  });

  it("a series gets one reminder and one audit row per occurrence, and one notification", async () => {
    await createBooking(
      input({
        occurrenceDates: [dateFromToday(7), dateFromToday(14), dateFromToday(21)],
        recurrence: { frequencyId: 2, occurrenceCount: 3 },
      })
    );

    assert.equal((await db.select().from(reminder_logs)).length, 3);
    assert.equal((await db.select().from(meeting_audit_logs)).length, 3);
    assert.equal((await db.select().from(notifications)).length, 1);
  });

  it("a rejected booking leaves no reminder, audit or notification behind", async () => {
    await createBooking(input());
    const before = [
      (await db.select().from(reminder_logs)).length,
      (await db.select().from(meeting_audit_logs)).length,
      (await db.select().from(notifications)).length,
    ];

    await assert.rejects(createBooking(input()), BookingError);

    assert.deepEqual(
      [
        (await db.select().from(reminder_logs)).length,
        (await db.select().from(meeting_audit_logs)).length,
        (await db.select().from(notifications)).length,
      ],
      before
    );
  });

  it("creating reminders twice cannot duplicate them", async () => {
    const { meetings } = await createBooking(input());

    await createRemindersForMeetings(db, [meetings[0].meeting_id]);
    await createRemindersForMeetings(db, [meetings[0].meeting_id]);

    assert.equal((await db.select().from(reminder_logs)).length, 1);
  });

  it("a reminder for a meeting starting very soon is due immediately", async () => {
    const soon = new Date(Date.now() + 5 * 60_000);
    const { date, time } = nowInAppTimezone(soon);
    const hhmm = time.slice(0, 5);
    // keep inside one day
    if (hhmm >= "23:00") return;

    const end = nowInAppTimezone(new Date(soon.getTime() + 30 * 60_000)).time.slice(0, 5);

    const { meetings } = await createBooking(
      input({ occurrenceDates: [date], startTime: hhmm, endTime: end })
    );

    const [r] = await db
      .select()
      .from(reminder_logs)
      .where(eq(reminder_logs.meeting_id, meetings[0].meeting_id));

    assert.ok(r.reminder_time.getTime() <= Date.now() + 1000);
  });
});

describe("reminder processing", () => {
  it("sends a due reminder once, marks it SENT and writes an audit row", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);

    const first = await processDueReminders();
    const second = await processDueReminders();

    assert.equal(first.sent, 1);
    assert.equal(second.sent, 0);
    assert.equal(mail.sent.length, 1);
    assert.match(mail.sent[0].subject, /Reminder/);
    assert.ok(mail.sent[0].to.includes(f.users.bob.email));
    assert.ok(mail.sent[0].to.includes(f.users.carol.email));

    const [r] = await db.select().from(reminder_logs);
    assert.equal(r.status, "SENT");

    const audits = await db.select().from(meeting_audit_logs);
    assert.ok(audits.some((a) => a.action === "REMINDER_SENT"));
  });

  it("leaves reminders that are not due yet alone", async () => {
    await createBooking(input());

    const result = await processDueReminders();

    assert.deepEqual(result, { sent: 0, skipped: 0, failed: 0, retried: 0 });
    assert.equal(mail.sent.length, 0);
  });

  it("concurrent workers (several instances) never double-send", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);

    await Promise.all(Array.from({ length: 6 }, () => processDueReminders()));

    assert.equal(mail.sent.length, 1);
    assert.equal((await db.select().from(reminder_logs))[0].status, "SENT");
  });

  it("retries after a transient failure and then succeeds", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);
    mail.setFailures(1);

    const first = await processDueReminders();
    let [r] = await db.select().from(reminder_logs);
    assert.deepEqual([first.retried, r.status, r.attempts], [1, "PENDING", 1]);

    const second = await processDueReminders();
    [r] = await db.select().from(reminder_logs);
    assert.deepEqual([second.sent, r.status, r.attempts], [1, "SENT", 2]);
    assert.equal(mail.sent.length, 1);
  });

  it("parks a reminder as FAILED after the attempt limit and stops retrying", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);
    mail.setFailures(100);

    await processDueReminders();
    await processDueReminders();
    const third = await processDueReminders();

    const [r] = await db.select().from(reminder_logs);
    assert.deepEqual([third.failed, r.status, r.attempts], [1, "FAILED", 3]);

    mail.setFailures(0);
    await processDueReminders();
    assert.equal(mail.sent.length, 0, "FAILED rows are not retried automatically");
  });

  it("one failing reminder does not block the others in the same run", async () => {
    const a = await createBooking(input({ startTime: "09:00", endTime: "10:00" }));
    const b = await createBooking(input({ startTime: "12:00", endTime: "13:00" }));
    await makeDue(a.meetings[0].meeting_id);
    await makeDue(b.meetings[0].meeting_id);
    mail.setFailures(1);

    const result = await processDueReminders();

    assert.equal(result.retried, 1);
    assert.equal(result.sent, 1);
  });

  it("skips reminders for cancelled meetings", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);
    await db
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.CANCELLED })
      .where(eq(meeting.meeting_id, meetings[0].meeting_id));

    const result = await processDueReminders();

    assert.equal(result.skipped, 1);
    assert.equal(mail.sent.length, 0);
    assert.equal((await db.select().from(reminder_logs))[0].status, "SKIPPED");
  });

  it("skips reminders for meetings that already ended", async () => {
    const { meetings } = await createBooking(input());
    await db
      .update(meeting)
      .set({ meeting_date: dateFromToday(-2) })
      .where(eq(meeting.meeting_id, meetings[0].meeting_id));
    await makeDue(meetings[0].meeting_id);

    const result = await processDueReminders();

    assert.equal(result.skipped, 1);
    assert.equal(mail.sent.length, 0);
  });
});

describe("booking e-mails (notifications outbox) (F-10)", () => {
  it("a booking sends its confirmation after commit and marks the row SENT", async () => {
    await createBooking(input({ notify: true }));

    assert.ok(
      await waitFor(async () => (await db.select().from(notifications))[0]?.status === "SENT")
    );
    assert.equal(mail.sent.length, 1);
    assert.match(mail.sent[0].subject, /Meeting Scheduled/);
  });

  it("a mail outage never fails or rolls back the booking, and it is retried later", async () => {
    mail.setFailures(100);

    const { meetings } = await createBooking(input({ notify: true }));

    assert.ok(meetings[0].meeting_id, "the booking succeeded");
    await waitFor(async () => (await db.select().from(notifications))[0]?.attempts === 1);

    assert.equal((await db.select().from(meeting)).length, 1);
    assert.equal((await db.select().from(notifications))[0].status, "PENDING");

    // Mail server is back: the retry pass delivers it.
    mail.setFailures(0);
    const retried = await processPendingNotifications(0);

    assert.equal(retried.SENT, 1);
    assert.equal(mail.sent.length, 1);
  });

  it("delivers exactly once even when several workers race", async () => {
    await createBooking(input());
    const [n] = await db.select().from(notifications);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => deliverNotification(n.notification_id))
    );

    assert.equal(results.filter((r) => r === "SENT").length, 1);
    assert.equal(mail.sent.length, 1);
  });

  it("gives up after the attempt limit", async () => {
    await createBooking(input());
    mail.setFailures(100);

    for (let i = 0; i < 4; i++) await processPendingNotifications(0);

    const [n] = await db.select().from(notifications);
    assert.deepEqual([n.status, n.attempts], ["FAILED", 3]);
  });

  it("the cron tick runs every step", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);

    const result = await runReminderTick();

    assert.equal(result.reminders.sent, 1);
  });
});

describe("meeting completion (cron)", () => {
  it("marks meetings completed by IST wall-clock time, with an audit row", async () => {
    const end = new Date(Date.now() - 60 * 60_000); // ended an hour ago
    const start = new Date(end.getTime() - 30 * 60_000);
    const e = nowInAppTimezone(end);
    const s = nowInAppTimezone(start);

    if (e.date !== s.date) return; // crossed midnight: skip rather than flake

    const [past] = await db
      .insert(meeting)
      .values({
        title: "ended",
        room_id: f.rooms.alpha.room_id,
        meeting_date: e.date,
        organizerEmployeeId: f.users.bob.employeeId,
        participantCount: 1,
        meetingTypeId: f.types.team,
        meetingStatusId: MEETING_STATUS.SCHEDULED,
        start_time: s.time,
        end_time: e.time,
      })
      .returning();

    const future = await createBooking(input());

    const updated = await updateCompletedMeetings();

    assert.equal(updated, 1);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, past.meeting_id));
    assert.equal(row.meetingStatusId, MEETING_STATUS.COMPLETED);

    const [other] = await db
      .select()
      .from(meeting)
      .where(eq(meeting.meeting_id, future.meetings[0].meeting_id));
    assert.equal(other.meetingStatusId, MEETING_STATUS.SCHEDULED);

    const audits = await db
      .select()
      .from(meeting_audit_logs)
      .where(eq(meeting_audit_logs.meeting_id, past.meeting_id));
    assert.ok(audits.some((a) => a.action === "MEETING_COMPLETED"));
  });
});
