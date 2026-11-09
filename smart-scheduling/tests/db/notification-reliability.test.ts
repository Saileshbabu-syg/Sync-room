import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import nodemailer from "nodemailer";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  meeting,
  meeting_attendees,
  meeting_audit_logs,
  notifications,
  reminder_logs,
} from "@/db/schema";
import { MAX_DELIVERY_ATTEMPTS, MEETING_STATUS } from "@/lib/constants";
import { runReminderTick, TICK_STEPS } from "@/lib/cron/reminder-job";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import {
  listFailedDeliveries,
  requeueFailedDelivery,
} from "@/lib/services/delivery-admin.service";
import { setMailTransport } from "@/lib/services/email.service";
import {
  deliverNotification,
  processPendingNotifications,
  queueMeetingNotification,
} from "@/lib/services/notification.service";
import { processDueReminders } from "@/lib/services/reminder.service";

import {
  captureMail,
  dateFromToday,
  minutesFromNow,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

// Phase 2: N1 (claim / send outside a transaction / record, crash recovery),
// N2 (cron isolation), N3 (stale messages), N5 (recipients and privacy), N8
// (backoff, permanent failures, administrator view and requeue).

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
  await db.update(employee).set({ is_active: true });
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
  participantCount: 3,
  meetingTypeId: f.types.team,
  participantEmployeeIds: [f.users.carol.employeeId, f.users.dave.employeeId],
  notify: false,
  ...o,
});

const makeDue = (meetingId: number) =>
  db
    .update(reminder_logs)
    .set({ reminder_time: new Date(Date.now() - 60_000) })
    .where(eq(reminder_logs.meeting_id, meetingId));

const row = async (id: number) =>
  (await db.select().from(notifications).where(eq(notifications.notification_id, id)))[0];

// A transport that runs `during` while the message is "being sent".
function hookMail(during: () => Promise<void>) {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const original = transport.sendMail.bind(transport);
  let sent = 0;

  (transport as unknown as { sendMail: unknown }).sendMail = async (
    message: Parameters<typeof original>[0]
  ) => {
    await during();
    sent++;

    return original(message);
  };

  setMailTransport(transport);

  return { count: () => sent };
}

function smtpError(responseCode: number, message: string) {
  return Object.assign(new Error(message), { responseCode, code: "EENVELOPE" });
}

// `solo`: no participants, so the confirmation is the only queued message.
async function bookingNotification(solo = false) {
  const result = await createBooking(
    solo ? input({ participantEmployeeIds: [], participantCount: 1 }) : input()
  );

  return { meetingId: result.meetings[0].meeting_id, id: result.notificationId };
}

describe("N1: claim, send outside a transaction, record", () => {
  it("sends with the claim already committed and no database transaction open", async () => {
    const { id } = await bookingNotification();
    let seenStatus = "";
    let openTransactions = -1;

    const hooked = hookMail(async () => {
      seenStatus = (await row(id)).status ?? "";

      const result = await db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state LIKE 'idle in transaction%'
      `);
      openTransactions = (result.rows[0] as { n: number }).n;
    });

    assert.equal(await deliverNotification(id), "SENT");

    assert.equal(hooked.count(), 1);
    assert.equal(seenStatus, "SENDING", "another connection already sees the committed claim");
    assert.equal(openTransactions, 0, "no transaction is held open during the send");
    assert.equal((await row(id)).status, "SENT");
  });

  it("two workers cannot claim the same notification, even while the send is slow", async () => {
    const { id } = await bookingNotification();
    const hooked = hookMail(() => new Promise((r) => setTimeout(r, 300)));

    const results = await Promise.all([deliverNotification(id), deliverNotification(id)]);

    assert.deepEqual(results.sort(), ["SENT", "SKIPPED"]);
    assert.equal(hooked.count(), 1);
  });

  it("a SENT notification is never sent again", async () => {
    const { id } = await bookingNotification(true);

    assert.equal(await deliverNotification(id), "SENT");
    assert.equal(await deliverNotification(id, minutesFromNow(600)), "SKIPPED");
    await processPendingNotifications(0, 50, minutesFromNow(600));

    assert.equal(mail.sent.length, 1);
  });

  it("a worker that died mid-send: the row is taken over once its lease expires", async () => {
    const { id } = await bookingNotification(true);

    // The crashed worker had claimed it (attempt 1) and never recorded a result.
    await db
      .update(notifications)
      .set({ status: "SENDING", attempts: 1, locked_until: minutesFromNow(5) })
      .where(eq(notifications.notification_id, id));

    // Lease still running: presumed alive, left alone.
    assert.equal((await processPendingNotifications(0)).SENT, 0);
    assert.equal(mail.sent.length, 0);

    // Lease expired: recovered and delivered.
    const recovered = await processPendingNotifications(0, 50, minutesFromNow(6));

    assert.equal(recovered.SENT, 1);
    assert.deepEqual([(await row(id)).status, (await row(id)).attempts], ["SENT", 2]);
    assert.equal(mail.sent.length, 1);
  });

  it("a worker that died during the final attempt: parked as FAILED, not sent beyond the limit", async () => {
    const { id } = await bookingNotification(true);

    await db
      .update(notifications)
      .set({
        status: "SENDING",
        attempts: MAX_DELIVERY_ATTEMPTS,
        // Relative to the database clock, which the queue compares against.
        locked_until: sql`now() - interval '1 minute'`,
      })
      .where(eq(notifications.notification_id, id));

    await processPendingNotifications(0);

    const r = await row(id);
    assert.equal(r.status, "FAILED");
    assert.match(r.last_error ?? "", /outcome unknown/);
    assert.equal(mail.sent.length, 0);
  });

  it("a late result from a worker whose lease was taken over is ignored", async () => {
    const { id } = await bookingNotification();

    // Worker A claimed attempt 1, then stalled; worker B took over (attempt 2)
    // and recorded SENT. A's late "failed" result must not overwrite that.
    await db
      .update(notifications)
      .set({ status: "SENDING", attempts: 1, locked_until: sql`now() - interval '1 second'` })
      .where(eq(notifications.notification_id, id));
    assert.equal(await deliverNotification(id), "SENT");

    await db.execute(sql`
      UPDATE notifications SET status = 'PENDING'
      WHERE notification_id = ${id} AND status = 'SENDING' AND attempts = 1
    `);

    assert.equal((await row(id)).status, "SENT");
  });
});

describe("N8: bounded retries with backoff, permanent failures, visibility", () => {
  it("backs off exponentially between attempts", async () => {
    const { id } = await bookingNotification();
    mail.setFailures(100);

    const t0 = minutesFromNow(0);
    assert.equal(await deliverNotification(id, t0), "RETRY");

    let r = await row(id);
    assert.equal(r.attempts, 1);
    assert.ok(Math.abs(r.next_attempt_at.getTime() - (t0.getTime() + 60_000)) < 2000, "1 minute");

    assert.equal(await deliverNotification(id, minutesFromNow(0.5)), "SKIPPED", "too early");

    const t1 = minutesFromNow(1.5);
    assert.equal(await deliverNotification(id, t1), "RETRY");

    r = await row(id);
    assert.equal(r.attempts, 2);
    assert.ok(Math.abs(r.next_attempt_at.getTime() - (t1.getTime() + 120_000)) < 2000, "2 minutes");
    assert.match(r.last_error ?? "", /simulated SMTP outage/);
  });

  it("a permanent SMTP refusal fails at once, with a reason that names no address", async () => {
    const { id } = await bookingNotification();

    hookMail(async () => {
      throw smtpError(550, "550 5.1.1 <bob.emp@example.test>: Recipient address rejected");
    });

    assert.equal(await deliverNotification(id), "FAILED");

    const r = await row(id);
    assert.equal(r.status, "FAILED");
    assert.equal(r.attempts, 1);
    assert.match(r.last_error ?? "", /SMTP 550/);
    assert.ok(!/@/.test(r.last_error ?? ""), r.last_error ?? "");
  });

  it("gives up after the attempt limit and is listed for administrators; a requeue delivers it", async () => {
    const { id, meetingId } = await bookingNotification();
    mail.setFailures(100);

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      await deliverNotification(id, minutesFromNow(2 ** (i + 1)));
    }

    assert.equal((await row(id)).status, "FAILED");

    const failed = await listFailedDeliveries();
    const listed = failed.find((x) => x.kind === "notification" && x.id === id);

    assert.ok(listed, "visible to administrators");
    assert.equal(listed.meetingId, meetingId);
    assert.equal(listed.attempts, MAX_DELIVERY_ATTEMPTS);
    assert.match(listed.lastError ?? "", /simulated SMTP outage/);

    mail.setFailures(0);
    assert.equal(await requeueFailedDelivery("notification", id, f.users.admin.employeeId), true);
    assert.equal(await deliverNotification(id), "SENT");
    assert.equal(mail.sent.length, 1);

    const audit = await db.select().from(meeting_audit_logs).where(eq(meeting_audit_logs.action, "EMAIL_REQUEUED"));
    assert.equal(audit.length, 1);

    assert.equal(
      await requeueFailedDelivery("notification", id, f.users.admin.employeeId),
      false,
      "only FAILED rows can be requeued"
    );
  });

  it("failed reminders are listed too", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);
    hookMail(async () => {
      throw smtpError(554, "554 rejected");
    });

    assert.equal((await processDueReminders()).failed, 1);
    assert.ok((await listFailedDeliveries()).some((x) => x.kind === "reminder" && x.meetingId === meetings[0].meeting_id));
  });
});

describe("N1: audit is separate from delivery", () => {
  it("an audit failure after a reminder was sent never causes a re-send", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_fail_reminder_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'REMINDER_SENT' THEN RAISE EXCEPTION 'audit store unavailable'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER test_fail_reminder_audit BEFORE INSERT ON meeting_audit_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_reminder_audit()
    `);

    try {
      assert.equal((await processDueReminders()).sent, 1);
      assert.equal((await processDueReminders(minutesFromNow(30))).sent, 0);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_reminder_audit ON meeting_audit_logs`);
    }

    const [r] = await db.select().from(reminder_logs);
    assert.equal(r.status, "SENT");
    assert.equal(mail.sent.length, 1);
  });
});

describe("N3: stale messages are not sent", () => {
  it("a queued update for a meeting cancelled meanwhile is skipped, the cancellation still goes out", async () => {
    const { meetingId } = await bookingNotification();
    const update = await queueMeetingNotification(db, meetingId, "UPDATED");

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.CANCELLED });
    const cancel = await queueMeetingNotification(db, meetingId, "CANCELLED");

    assert.equal(await deliverNotification(update), "SKIPPED");
    assert.match((await row(update)).last_error ?? "", /no longer scheduled/);
    assert.equal(await deliverNotification(cancel), "SENT");

    assert.equal(mail.sent.length, 1);
    assert.match(mail.sent[0].subject, /Cancelled/);
  });

  it("a booking confirmation still queued when the meeting was replaced is skipped", async () => {
    const { id } = await bookingNotification();

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.PREEMPTED });

    assert.equal(await deliverNotification(id), "SKIPPED");
    assert.equal(mail.sent.length, 0);
  });

  it("a confirmation for a meeting that already ended is skipped", async () => {
    const { id } = await bookingNotification();

    await db.update(meeting).set({ meeting_date: dateFromToday(-2) });

    assert.equal(await deliverNotification(id), "SKIPPED");
    assert.equal(mail.sent.length, 0);
  });
});

describe("N5: recipients", () => {
  const decline = (employeeId: number) =>
    db
      .update(meeting_attendees)
      .set({ response_status: "DECLINED" })
      .where(eq(meeting_attendees.employee_id, employeeId));

  it("declined attendees get no reminder", async () => {
    const { meetings } = await createBooking(input());
    await decline(f.users.carol.employeeId);
    await makeDue(meetings[0].meeting_id);

    await processDueReminders();

    assert.equal(mail.sent.length, 1);
    assert.ok(!mail.sent[0].to.includes(f.users.carol.email));
    assert.ok(mail.sent[0].to.includes(f.users.bob.email));
    assert.ok(mail.sent[0].to.includes(f.users.dave.email));
  });

  it("declined attendees get no update, but do hear about a cancellation", async () => {
    const { meetingId } = await bookingNotification();
    await decline(f.users.carol.employeeId);

    await deliverNotification(await queueMeetingNotification(db, meetingId, "UPDATED"));
    const updateMail = mail.sent.at(-1)!;
    assert.match(updateMail.subject, /Updated/);
    assert.ok(!updateMail.to.includes(f.users.carol.email));

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.CANCELLED });
    await deliverNotification(await queueMeetingNotification(db, meetingId, "CANCELLED"));
    assert.ok(mail.sent.at(-1)!.to.includes(f.users.carol.email));
  });

  it("deactivated employees are not mailed", async () => {
    const { meetings } = await createBooking(input());
    await db.update(employee).set({ is_active: false }).where(eq(employee.employee_id, f.users.dave.employeeId));
    await makeDue(meetings[0].meeting_id);

    await processDueReminders();

    assert.ok(!mail.sent[0].to.includes(f.users.dave.email));
  });

  it("attendees cannot see each other's addresses: one Bcc message, nobody in To", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);

    await processDueReminders();

    const [m] = mail.sent;
    assert.equal(m.visibleTo, "", "no visible To / Cc list");
    assert.deepEqual(
      m.bcc.split(",").sort(),
      [f.users.bob.email, f.users.carol.email, f.users.dave.email].sort()
    );
  });

  it("the organizer's confirmation still goes to the organizer alone, in To", async () => {
    const { id } = await bookingNotification();

    await deliverNotification(id);

    assert.equal(mail.sent[0].visibleTo, f.users.bob.email);
    assert.equal(mail.sent[0].bcc, "");
  });
});

describe("N2: cron isolation", () => {
  it("a failing step does not stop the steps after it", async () => {
    const { meetings } = await createBooking(input());
    await makeDue(meetings[0].meeting_id);

    const result = await runReminderTick({
      ...TICK_STEPS,
      processExpiredBumps: async () => {
        throw new Error("bad row in the bump sweep");
      },
      updateCompletedMeetings: async () => {
        throw new Error("database hiccup");
      },
    });

    assert.equal(result.expiredBumps, 0);
    assert.equal(result.completed, 0);
    assert.equal(result.reminders.sent, 1, "reminders still went out");
    assert.equal(mail.sent.length, 1);
  });
});

