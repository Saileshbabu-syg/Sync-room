import { and, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  meeting,
  meeting_attendees,
  reminder_logs,
  room,
} from "@/db/schema";
import {
  APP_TIMEZONE,
  MAX_DELIVERY_ATTEMPTS,
  MEETING_STATUS,
  REMINDER_LEAD_MINUTES,
} from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";
import {
  addSeconds,
  backoffSeconds,
  DELIVERY_LEASE_SECONDS,
  isPermanentMailError,
  safeErrorMessage,
} from "@/lib/delivery-policy";
import { isMeetingEnded } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { sendMeetingEmail } from "./email.service";
import { loadSeriesEmailContext } from "./meeting-series.service";

// Reminders are event-driven rows: one `reminder_logs` row is written for every
// meeting in the same transaction that creates it (see booking.service), and
// the per-minute cron job (lib/cron/reminder-job.ts) sends whatever is due.

// Creates the (single) reminder row for each meeting. Idempotent: the unique
// index on meeting_id means retries and double submits cannot duplicate it. The
// reminder is due REMINDER_LEAD_MINUTES before the meeting starts (wall-clock
// date + time interpreted in APP_TIMEZONE), or immediately if that moment has
// already passed.
export async function createRemindersForMeetings(
  executor: DbExecutor,
  meetingIds: number[]
) {
  if (meetingIds.length === 0) return;

  await executor.execute(sql`
    INSERT INTO reminder_logs (meeting_id, reminder_time, status)
    SELECT
      m.meeting_id,
      GREATEST(
        ((m.meeting_date + m.start_time) AT TIME ZONE ${APP_TIMEZONE}::text)
          - make_interval(mins => ${REMINDER_LEAD_MINUTES}),
        now()
      ),
      'PENDING'
    FROM meeting m
    WHERE m.meeting_id IN (${sql.join(
      meetingIds.map((id) => sql`${id}`),
      sql`, `
    )})
    ON CONFLICT (meeting_id) DO NOTHING
  `);
}

export async function getPendingReminders(now: Date = new Date()) {
  return await db
    .select()
    .from(reminder_logs)
    .where(
      and(
        eq(reminder_logs.status, "PENDING"),
        lte(reminder_logs.reminder_time, now)
      )
    );
}

// The people a meeting e-mail goes to: its attendees (the organizer is one),
// never anyone deactivated. `excludeDeclined` leaves out people who declined,
// for messages about a meeting that still happens (reminders, updates); news
// that it is off (cancellation, replacement) still reaches everyone.
export async function getMeetingAttendees(
  meetingId: number,
  executor: DbExecutor = db,
  { excludeDeclined = false }: { excludeDeclined?: boolean } = {}
) {
  return await executor
    .select({
      email: employee.email,
      employee_name: employee.employee_name,
    })
    .from(meeting_attendees)
    .innerJoin(
      employee,
      eq(meeting_attendees.employee_id, employee.employee_id)
    )
    .where(
      and(
        eq(meeting_attendees.meeting_id, meetingId),
        eq(employee.is_active, true),
        excludeDeclined
          ? sql`${meeting_attendees.response_status} IS DISTINCT FROM 'DECLINED'`
          : undefined
      )
    );
}

export async function getMeetingDetails(
  meetingId: number,
  executor: DbExecutor = db
) {
  const result = await executor
    .select()
    .from(meeting)
    .where(eq(meeting.meeting_id, meetingId));

  return result[0];
}

type ReminderRow = typeof reminder_logs.$inferSelect;

// Parks reminders whose worker died during their LAST allowed attempt: the
// outcome of that send is unknown, and retrying would exceed the limit.
async function failAbandonedReminders(now: Date) {
  await db
    .update(reminder_logs)
    .set({
      status: "FAILED",
      locked_until: null,
      last_error:
        "The worker stopped during the final attempt; delivery outcome unknown.",
    })
    .where(
      and(
        eq(reminder_logs.status, "SENDING"),
        lte(reminder_logs.locked_until, now),
        gte(reminder_logs.attempts, MAX_DELIVERY_ATTEMPTS)
      )
    );
}

// Claims the next due reminder and COMMITS the claim before anything is sent:
// one statement flips it to SENDING under a lease and counts the attempt. Due
// means PENDING and past both its reminder time and its backoff, or SENDING
// with an expired lease (its worker died). SKIP LOCKED + the status change
// mean two workers can never claim the same row.
async function claimDueReminder(now: Date, exclude: number[]) {
  const result = await db.execute(sql`
    UPDATE reminder_logs
    SET status = 'SENDING',
        attempts = attempts + 1,
        locked_until = ${addSeconds(now, DELIVERY_LEASE_SECONDS)}
    WHERE reminder_log_id = (
      SELECT reminder_log_id FROM reminder_logs
      WHERE (
          (status = 'PENDING' AND reminder_time <= ${now} AND next_attempt_at <= ${now})
          OR (status = 'SENDING' AND locked_until <= ${now})
        )
        AND attempts < ${MAX_DELIVERY_ATTEMPTS}
        AND reminder_log_id <> ALL(${`{${exclude.join(",")}}`}::int[])
      ORDER BY reminder_time
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING reminder_log_id, meeting_id, attempts
  `);

  return (result.rows[0] ?? null) as Pick<
    ReminderRow,
    "reminder_log_id" | "meeting_id" | "attempts"
  > | null;
}

// Records the outcome of an attempt. `attempts` fences it: if the lease ran out
// and another worker re-claimed the row meanwhile (attempts moved on), this
// late result is dropped instead of overwriting the newer attempt's.
async function finishReminder(
  claim: Pick<ReminderRow, "reminder_log_id" | "attempts">,
  values: Partial<typeof reminder_logs.$inferInsert>
) {
  await db
    .update(reminder_logs)
    .set({ locked_until: null, ...values })
    .where(
      and(
        eq(reminder_logs.reminder_log_id, claim.reminder_log_id),
        eq(reminder_logs.status, "SENDING"),
        eq(reminder_logs.attempts, claim.attempts)
      )
    );
}

// Sends every reminder that is due. Safe to run from several instances at once
// and after a crash:
//  - a reminder is claimed (SENDING, under a lease) in its own committed
//    statement, so two workers never send the same one, and no database
//    transaction stays open while the mail server is talked to;
//  - the result is recorded afterwards: SENT, or back to PENDING with an
//    exponential backoff (lib/delivery-policy.ts), or FAILED once the attempts
//    are used up or the relay refused it permanently;
//  - a worker that dies mid-send leaves the row SENDING; when the lease
//    expires another worker retries it. Delivery is therefore AT LEAST ONCE: a
//    crash after the relay accepted the message but before SENT was recorded
//    sends it again;
//  - reminders for meetings that were cancelled or already ended are SKIPPED;
//  - the audit row is written after SENT is recorded and outside the delivery
//    error handling, so an audit failure can never cause a re-send.
export async function processDueReminders(now: Date = new Date()) {
  const summary = { sent: 0, skipped: 0, failed: 0, retried: 0 };
  // Rows that failed in this run are not claimed again within it.
  const retriedIds: number[] = [0];

  await failAbandonedReminders(now);

  for (let i = 0; i < 500; i++) {
    const claim = await claimDueReminder(now, retriedIds);

    if (!claim) break;

    const outcome = await deliverReminder(claim, now);

    if (outcome === "retried") retriedIds.push(claim.reminder_log_id);

    summary[outcome]++;
  }

  return summary;
}

async function deliverReminder(
  claim: Pick<ReminderRow, "reminder_log_id" | "meeting_id" | "attempts">,
  now: Date
): Promise<"sent" | "skipped" | "failed" | "retried"> {
  let recipients: string[];
  let send: () => Promise<unknown>;

  try {
    const details = await getMeetingDetails(claim.meeting_id);

    if (
      !details ||
      details.meetingStatusId !== MEETING_STATUS.SCHEDULED ||
      isMeetingEnded(details.meeting_date, details.end_time, now)
    ) {
      await finishReminder(claim, {
        status: "SKIPPED",
        last_error: "The meeting is no longer scheduled or has ended.",
      });

      return "skipped";
    }

    // People who declined are not reminded.
    recipients = (
      await getMeetingAttendees(claim.meeting_id, db, { excludeDeclined: true })
    )
      .map((a) => a.email)
      .filter((email): email is string => Boolean(email));

    // A reminder for one occurrence of a recurring series also tells the
    // attendees about the whole series.
    const series =
      details.recurringMeetingId !== null
        ? await loadSeriesEmailContext(db, details.recurringMeetingId)
        : null;

    const [roomRow] = await db
      .select({ name: room.room_name })
      .from(room)
      .where(eq(room.room_id, details.room_id));
    const roomName = roomRow?.name;

    send = () =>
      sendMeetingEmail(
        recipients,
        details.title,
        String(details.meeting_date),
        String(details.start_time),
        String(details.end_time),
        "reminder",
        {
          roomName,
          ...(series ?? {}),
          // The reminder re-sends this meeting's entry at its current version:
          // same UID and SEQUENCE, so calendars see no change.
          calendar: { meetingId: details.meeting_id, sequence: details.ics_sequence },
          ...(details.is_online && details.online_join_url
            ? { online: { joinUrl: details.online_join_url } }
            : {}),
        }
      );
  } catch (error) {
    // Could not even prepare the message (e.g. a database hiccup): a normal,
    // retryable failure of this attempt.
    return failReminder(claim, error, now);
  }

  try {
    if (recipients.length > 0) await send();
  } catch (error) {
    return failReminder(claim, error, now);
  }

  await finishReminder(claim, { status: "SENT", last_error: null });

  try {
    await createAuditLog(
      claim.meeting_id,
      AUDIT_ACTION.REMINDER_SENT,
      `Reminder sent to ${recipients.length} attendee(s)`,
      null
    );
  } catch (error) {
    // Already sent and recorded as SENT: an audit problem is only logged.
    console.error(
      `Reminder ${claim.reminder_log_id}: sent, but the audit row failed:`,
      error instanceof Error ? error.message : "unknown error"
    );
  }

  return "sent";
}

async function failReminder(
  claim: Pick<ReminderRow, "reminder_log_id" | "attempts">,
  error: unknown,
  now: Date
): Promise<"failed" | "retried"> {
  const reason = safeErrorMessage(error);
  const exhausted =
    isPermanentMailError(error) || claim.attempts >= MAX_DELIVERY_ATTEMPTS;

  console.error(
    `Reminder ${claim.reminder_log_id} delivery failed (attempt ${claim.attempts}):`,
    reason
  );

  await finishReminder(
    claim,
    exhausted
      ? { status: "FAILED", last_error: reason }
      : {
          status: "PENDING",
          last_error: reason,
          next_attempt_at: addSeconds(now, backoffSeconds(claim.attempts)),
        }
  );

  return exhausted ? "failed" : "retried";
}
