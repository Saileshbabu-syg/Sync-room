import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  meeting,
  notification_type_master,
  notifications,
  reminder_logs,
} from "@/db/schema";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";

// Administrator view of e-mails that could not be delivered: notifications and
// reminders parked as FAILED, with the (address-free) reason, and a way to put
// one back in the queue once the cause is fixed (e.g. the relay is back).

export type DeliveryKind = "notification" | "reminder";

export type FailedDelivery = {
  kind: DeliveryKind;
  id: number;
  meetingId: number;
  meetingTitle: string;
  meetingDate: string;
  type: string;
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
};

export async function listFailedDeliveries(limit = 100): Promise<FailedDelivery[]> {
  const failedNotifications = await db
    .select({
      id: notifications.notification_id,
      meetingId: notifications.meeting_id,
      meetingTitle: meeting.title,
      meetingDate: meeting.meeting_date,
      type: notification_type_master.notification_type_name,
      attempts: notifications.attempts,
      lastError: notifications.last_error,
      createdAt: notifications.created_at,
    })
    .from(notifications)
    .innerJoin(meeting, eq(meeting.meeting_id, notifications.meeting_id))
    .innerJoin(
      notification_type_master,
      eq(
        notification_type_master.notification_type_id,
        notifications.notification_type_id
      )
    )
    .where(eq(notifications.status, "FAILED"))
    .orderBy(desc(notifications.notification_id))
    .limit(limit);

  const failedReminders = await db
    .select({
      id: reminder_logs.reminder_log_id,
      meetingId: reminder_logs.meeting_id,
      meetingTitle: meeting.title,
      meetingDate: meeting.meeting_date,
      attempts: reminder_logs.attempts,
      lastError: reminder_logs.last_error,
      createdAt: reminder_logs.created_at,
    })
    .from(reminder_logs)
    .innerJoin(meeting, eq(meeting.meeting_id, reminder_logs.meeting_id))
    .where(eq(reminder_logs.status, "FAILED"))
    .orderBy(desc(reminder_logs.reminder_log_id))
    .limit(limit);

  return [
    ...failedNotifications.map((n) => ({
      kind: "notification" as const,
      ...n,
      meetingDate: String(n.meetingDate),
      createdAt: n.createdAt?.toISOString() ?? null,
    })),
    ...failedReminders.map((r) => ({
      kind: "reminder" as const,
      ...r,
      type: "REMINDER",
      meetingDate: String(r.meetingDate),
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
  ]
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, limit);
}

// Puts one FAILED e-mail back in the queue with a fresh set of attempts. The
// usual checks run again on delivery, so a message that no longer applies (the
// meeting was cancelled meanwhile) is skipped rather than sent. Returns false
// when there is no such FAILED row.
export async function requeueFailedDelivery(
  kind: DeliveryKind,
  id: number,
  actorEmployeeId: number
) {
  // The database's clock, like the queue that compares against it (an app
  // server whose clock runs ahead would otherwise delay the retry).
  const values = {
    status: "PENDING",
    attempts: 0,
    next_attempt_at: sql`now()`,
    locked_until: null,
  };

  const [row] =
    kind === "notification"
      ? await db
          .update(notifications)
          .set(values)
          .where(
            and(eq(notifications.notification_id, id), eq(notifications.status, "FAILED"))
          )
          .returning({ meetingId: notifications.meeting_id })
      : await db
          .update(reminder_logs)
          .set(values)
          .where(
            and(eq(reminder_logs.reminder_log_id, id), eq(reminder_logs.status, "FAILED"))
          )
          .returning({ meetingId: reminder_logs.meeting_id });

  if (!row) return false;

  await createAuditLog(
    row.meetingId,
    AUDIT_ACTION.EMAIL_REQUEUED,
    `Failed ${kind} ${id} put back in the e-mail queue`,
    actorEmployeeId
  );

  return true;
}
