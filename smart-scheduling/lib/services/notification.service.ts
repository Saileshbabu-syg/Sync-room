import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { notification_type_master, notifications } from "@/db/schema";
import { MAX_DELIVERY_ATTEMPTS, NOTIFICATION_TYPE } from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";

import { getMeetingAttendees, getMeetingDetails } from "./reminder.service";
import { sendMeetingEmail } from "./email.service";

// Booking / edit e-mails go through the `notifications` table, which acts as a
// small outbox:
//   1. the request transaction inserts a PENDING row (so the intent is
//      committed together with the meeting);
//   2. after commit, dispatchNotification() delivers it in the background — the
//      HTTP response never waits for, or fails because of, the mail server;
//   3. rows that could not be delivered stay PENDING and are retried by the
//      cron job (processPendingNotifications) up to MAX_DELIVERY_ATTEMPTS,
//      then are parked as FAILED.

type NotificationKind = keyof typeof NOTIFICATION_TYPE;

async function ensureNotificationTypeId(executor: DbExecutor, name: string) {
  await executor
    .insert(notification_type_master)
    .values({ notification_type_name: name })
    .onConflictDoNothing();

  const [row] = await executor
    .select({ id: notification_type_master.notification_type_id })
    .from(notification_type_master)
    .where(eq(notification_type_master.notification_type_name, name));

  return row.id;
}

export async function queueMeetingNotification(
  executor: DbExecutor,
  meetingId: number,
  kind: NotificationKind
): Promise<number> {
  const typeId = await ensureNotificationTypeId(
    executor,
    NOTIFICATION_TYPE[kind]
  );

  const [row] = await executor
    .insert(notifications)
    .values({
      meeting_id: meetingId,
      notification_type_id: typeId,
      status: "PENDING",
    })
    .returning({ id: notifications.notification_id });

  return row.id;
}

export type DeliveryResult = "SENT" | "RETRY" | "FAILED" | "SKIPPED";

// Delivers one notification. The row is claimed with FOR UPDATE SKIP LOCKED, so
// the immediate post-commit attempt and the cron retry (or two instances) can
// never both send it; a row that is already SENT/FAILED is left alone.
export async function deliverNotification(
  notificationId: number
): Promise<DeliveryResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.notification_id, notificationId),
          eq(notifications.status, "PENDING")
        )
      )
      .for("update", { skipLocked: true });

    if (!row) return "SKIPPED" as const;

    const details = await getMeetingDetails(row.meeting_id, tx);

    if (!details) {
      await tx
        .update(notifications)
        .set({ status: "FAILED", attempts: row.attempts + 1 })
        .where(eq(notifications.notification_id, notificationId));

      return "FAILED" as const;
    }

    const [type] = await tx
      .select({ name: notification_type_master.notification_type_name })
      .from(notification_type_master)
      .where(
        eq(
          notification_type_master.notification_type_id,
          row.notification_type_id
        )
      );

    const recipients = (await getMeetingAttendees(row.meeting_id, tx))
      .map((a) => a.email)
      .filter((email): email is string => Boolean(email));

    try {
      if (recipients.length > 0) {
        // One message to all attendees: delivery is all-or-nothing, so a retry
        // can never re-send to people who already received it.
        await sendMeetingEmail(
          recipients,
          details.title,
          String(details.meeting_date),
          String(details.start_time),
          String(details.end_time),
          type?.name === NOTIFICATION_TYPE.UPDATED ? "updated" : "scheduled"
        );
      }

      await tx
        .update(notifications)
        .set({
          status: "SENT",
          sent_at: new Date(),
          attempts: row.attempts + 1,
        })
        .where(eq(notifications.notification_id, notificationId));

      return "SENT" as const;
    } catch (error) {
      console.error(
        `Notification ${notificationId} delivery failed:`,
        error instanceof Error ? error.message : error
      );

      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;

      await tx
        .update(notifications)
        .set({ attempts, status: exhausted ? "FAILED" : "PENDING" })
        .where(eq(notifications.notification_id, notificationId));

      return (exhausted ? "FAILED" : "RETRY") as DeliveryResult;
    }
  });
}

// Fire-and-forget after the request transaction has committed. Never throws
// and never delays the response.
export function dispatchNotification(notificationId: number | undefined) {
  if (notificationId === undefined) return;

  void deliverNotification(notificationId).catch((error) => {
    console.error(
      `Notification ${notificationId} dispatch error:`,
      error instanceof Error ? error.message : error
    );
  });
}

// Cron retry pass: picks up PENDING rows that the immediate attempt did not
// finish. `minAgeSeconds` leaves fresh rows to their own immediate attempt.
export async function processPendingNotifications(
  minAgeSeconds = 30,
  limit = 50
) {
  const due = await db
    .select({ id: notifications.notification_id })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "PENDING"),
        sql`${notifications.created_at} <= now() - make_interval(secs => ${minAgeSeconds})`,
        sql`${notifications.attempts} < ${MAX_DELIVERY_ATTEMPTS}`
      )
    )
    .orderBy(asc(notifications.notification_id))
    .limit(limit);

  const summary: Record<DeliveryResult, number> = {
    SENT: 0,
    RETRY: 0,
    FAILED: 0,
    SKIPPED: 0,
  };

  for (const { id } of due) {
    summary[await deliverNotification(id)]++;
  }

  return summary;
}
