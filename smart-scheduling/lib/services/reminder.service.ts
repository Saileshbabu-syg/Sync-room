import { and, asc, eq, lte, notInArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  meeting,
  meeting_attendees,
  reminder_logs,
} from "@/db/schema";
import {
  APP_TIMEZONE,
  MAX_DELIVERY_ATTEMPTS,
  MEETING_STATUS,
  REMINDER_LEAD_MINUTES,
} from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";
import { isMeetingEnded } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { sendMeetingEmail } from "./email.service";

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

export async function getMeetingAttendees(
  meetingId: number,
  executor: DbExecutor = db
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
    .where(eq(meeting_attendees.meeting_id, meetingId));
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

// Sends every reminder that is due. Safe to run from several instances at once
// and to re-run after a crash:
//  - each reminder is claimed with FOR UPDATE SKIP LOCKED inside its own
//    transaction, so two workers never send the same one;
//  - a successful send flips the row to SENT in the same transaction, so a
//    SENT reminder is never sent again;
//  - a failed send bumps `attempts` and leaves the row PENDING (retried on the
//    next tick) until MAX_DELIVERY_ATTEMPTS, then parks it as FAILED;
//  - reminders for meetings that were cancelled or already ended are SKIPPED.
export async function processDueReminders(now: Date = new Date()) {
  const summary = { sent: 0, skipped: 0, failed: 0, retried: 0 };
  // Rows that failed but stay PENDING are not picked again within this run.
  const retriedIds: number[] = [0];

  for (let i = 0; i < 500; i++) {
    const outcome = await db.transaction(async (tx) => {
      const [reminder] = await tx
        .select()
        .from(reminder_logs)
        .where(
          and(
            eq(reminder_logs.status, "PENDING"),
            lte(reminder_logs.reminder_time, now),
            notInArray(reminder_logs.reminder_log_id, retriedIds)
          )
        )
        .orderBy(asc(reminder_logs.reminder_time))
        .limit(1)
        .for("update", { skipLocked: true });

      if (!reminder) return null;

      const details = await getMeetingDetails(reminder.meeting_id, tx);

      if (
        !details ||
        details.meetingStatusId !== MEETING_STATUS.SCHEDULED ||
        isMeetingEnded(details.meeting_date, details.end_time, now)
      ) {
        await tx
          .update(reminder_logs)
          .set({ status: "SKIPPED" })
          .where(eq(reminder_logs.reminder_log_id, reminder.reminder_log_id));

        return "skipped" as const;
      }

      const recipients = (await getMeetingAttendees(reminder.meeting_id, tx))
        .map((a) => a.email)
        .filter((email): email is string => Boolean(email));

      try {
        if (recipients.length > 0) {
          await sendMeetingEmail(
            recipients,
            details.title,
            String(details.meeting_date),
            String(details.start_time),
            String(details.end_time),
            "reminder"
          );
        }

        await tx
          .update(reminder_logs)
          .set({ status: "SENT", attempts: reminder.attempts + 1 })
          .where(eq(reminder_logs.reminder_log_id, reminder.reminder_log_id));

        await createAuditLog(
          reminder.meeting_id,
          AUDIT_ACTION.REMINDER_SENT,
          `Reminder sent to ${recipients.length} attendee(s)`,
          null,
          tx
        );

        return "sent" as const;
      } catch (error) {
        console.error(
          `Reminder ${reminder.reminder_log_id} delivery failed:`,
          error instanceof Error ? error.message : error
        );

        const attempts = reminder.attempts + 1;
        const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;

        await tx
          .update(reminder_logs)
          .set({ attempts, status: exhausted ? "FAILED" : "PENDING" })
          .where(eq(reminder_logs.reminder_log_id, reminder.reminder_log_id));

        if (!exhausted) retriedIds.push(reminder.reminder_log_id);

        return (exhausted ? "failed" : "retried") as "failed" | "retried";
      }
    });

    if (outcome === null) break;

    summary[outcome]++;
  }

  return summary;
}
