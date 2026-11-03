import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  employee,
  groups,
  meeting,
  meeting_attendees,
  meetingTypes,
  notification_type_master,
  notifications,
  reschedule_requests,
  room,
} from "@/db/schema";
import {
  MAX_DELIVERY_ATTEMPTS,
  MEETING_STATUS,
  NOTIFICATION_TYPE,
} from "@/lib/constants";
import { invitationLink } from "@/lib/invitation-token";
import type { DbExecutor } from "@/lib/db-types";
import { nowInAppTimezone } from "@/lib/time";

import { getMeetingAttendees, getMeetingDetails } from "./reminder.service";
import {
  sendInvitationEmail,
  sendMeetingEmail,
  type MeetingBumpInfo,
  type MeetingEmailKind,
  type MeetingPreemptionInfo,
} from "./email.service";
import {
  loadSeriesEmailContext,
  type SeriesEmailContext,
} from "./meeting-series.service";

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

// Who took the slot of a bumped meeting and whether it is still waiting for its
// organizer (deadline) or already cancelled. The claiming meeting sits in the
// room the bumped one used to have.
async function loadBumpInfo(
  executor: DbExecutor,
  bumpedMeetingId: number,
  currentRoomId: number
): Promise<MeetingBumpInfo | undefined> {
  const [request] = await executor
    .select({
      requestStatus: reschedule_requests.status,
      deadline: reschedule_requests.deadline,
      claimantType: meetingTypes.meetingTypeName,
      claimantOrganizer: employee.employee_name,
    })
    .from(reschedule_requests)
    .innerJoin(
      meeting,
      eq(meeting.meeting_id, reschedule_requests.claimant_meeting_id)
    )
    .innerJoin(meetingTypes, eq(meetingTypes.meetingTypeId, meeting.meetingTypeId))
    .innerJoin(employee, eq(employee.employee_id, meeting.organizerEmployeeId))
    .where(eq(reschedule_requests.bumped_meeting_id, bumpedMeetingId))
    .orderBy(desc(reschedule_requests.reschedule_request_id))
    .limit(1);

  if (!request) return undefined;

  const roomName = async (roomId: number) =>
    (
      await executor
        .select({ name: room.room_name })
        .from(room)
        .where(eq(room.room_id, roomId))
    )[0]?.name ?? "the room";

  const appUrl = process.env.NEXTAUTH_URL?.replace(/\/+$/, "");
  const pending = request.requestStatus === "PENDING";
  const due = nowInAppTimezone(request.deadline);

  return {
    claimedBy: `${request.claimantType} organized by ${request.claimantOrganizer}`,
    roomName: await roomName(currentRoomId),
    deadline: pending ? `${due.date} ${due.time.slice(0, 5)}` : undefined,
    changeUrl: appUrl ? `${appUrl}/bookings/${bumpedMeetingId}/edit` : undefined,
    rebookUrl: appUrl ? `${appUrl}/booking` : undefined,
  };
}

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
  kind: NotificationKind,
  // Only for per-person messages (invitations).
  recipientEmployeeId?: number
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
      recipient_employee_id: recipientEmployeeId ?? null,
      status: "PENDING",
    })
    .returning({ id: notifications.notification_id });

  return row.id;
}

// Sends one participant their invitation (Accept / Decline links). Runs inside
// deliverNotification's transaction, which already holds the row's lock.
async function deliverInvitation(
  tx: DbExecutor,
  row: typeof notifications.$inferSelect,
  details: NonNullable<Awaited<ReturnType<typeof getMeetingDetails>>>
): Promise<DeliveryResult> {
  const finish = async (status: string, attempts = row.attempts + 1) => {
    await tx
      .update(notifications)
      .set({
        status,
        attempts,
        ...(status === "SENT" ? { sent_at: new Date() } : {}),
      })
      .where(eq(notifications.notification_id, row.notification_id));
  };

  // Nothing to answer once the meeting is gone.
  if (details.meetingStatusId !== MEETING_STATUS.SCHEDULED) {
    await finish("SKIPPED");

    return "SKIPPED";
  }

  const [recipient] = row.recipient_employee_id
    ? await tx
        .select({
          email: employee.email,
          optional: meeting_attendees.is_optional,
        })
        .from(employee)
        .leftJoin(
          meeting_attendees,
          and(
            eq(meeting_attendees.employee_id, employee.employee_id),
            eq(meeting_attendees.meeting_id, row.meeting_id)
          )
        )
        .where(eq(employee.employee_id, row.recipient_employee_id))
    : [];

  const [organizer] = await tx
    .select({ name: employee.employee_name })
    .from(employee)
    .where(eq(employee.employee_id, details.organizerEmployeeId));

  const [roomRow] = await tx
    .select({ name: room.room_name })
    .from(room)
    .where(eq(room.room_id, details.room_id));

  if (!recipient?.email || !row.recipient_employee_id) {
    await finish("FAILED");

    return "FAILED";
  }

  try {
    await sendInvitationEmail(recipient.email, {
      title: details.title,
      organizerName: organizer?.name ?? "",
      roomName: roomRow?.name ?? "",
      meetingDate: String(details.meeting_date),
      startTime: String(details.start_time),
      endTime: String(details.end_time),
      acceptUrl: invitationLink(
        details.meeting_id,
        row.recipient_employee_id,
        "accept"
      ),
      declineUrl: invitationLink(
        details.meeting_id,
        row.recipient_employee_id,
        "decline"
      ),
      optional: recipient.optional === true,
      seriesNote:
        details.recurringMeetingId !== null
          ? "This is part of a recurring series. Your answer applies to every occurrence."
          : undefined,
    });

    await finish("SENT");

    return "SENT";
  } catch (error) {
    console.error(
      `Invitation ${row.notification_id} delivery failed:`,
      error instanceof Error ? error.message : error
    );

    const attempts = row.attempts + 1;
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;

    await finish(exhausted ? "FAILED" : "PENDING", attempts);

    return exhausted ? "FAILED" : "RETRY";
  }
}

// Who took the room of a preempted meeting, from the append-only history row.
async function loadPreemptionInfo(
  executor: DbExecutor,
  affectedMeetingId: number,
  roomId: number
): Promise<MeetingPreemptionInfo | undefined> {
  const [history] = await executor
    .select({
      incomingGroup: groups.name,
      incomingPriority: bookingPriorityHistory.incomingPriority,
    })
    .from(bookingPriorityHistory)
    .leftJoin(groups, eq(groups.id, bookingPriorityHistory.incomingGroupId))
    .where(eq(bookingPriorityHistory.affectedBookingId, affectedMeetingId))
    .orderBy(desc(bookingPriorityHistory.id))
    .limit(1);

  if (!history) return undefined;

  const [roomRow] = await executor
    .select({ name: room.room_name })
    .from(room)
    .where(eq(room.room_id, roomId));

  const appUrl = process.env.NEXTAUTH_URL?.replace(/\/+$/, "");

  return {
    roomName: roomRow?.name ?? "the room",
    claimedBy: `a ${history.incomingGroup ?? "higher-priority"} booking (priority ${history.incomingPriority})`,
    rebookUrl: appUrl ? `${appUrl}/booking` : undefined,
  };
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

    if (type?.name === NOTIFICATION_TYPE.INVITED) {
      return deliverInvitation(tx, row, details);
    }

    let recipients = (await getMeetingAttendees(row.meeting_id, tx))
      .map((a) => a.email)
      .filter((email): email is string => Boolean(email));

    const isBooking = type?.name === NOTIFICATION_TYPE.BOOKED;

    // The organizer gets the booking confirmation; every other participant
    // gets their own invitation (deliverInvitation) instead of a copy of it.
    if (isBooking) {
      const [organizerRow] = await tx
        .select({ email: employee.email })
        .from(employee)
        .where(eq(employee.employee_id, details.organizerEmployeeId));

      if (organizerRow?.email) recipients = [organizerRow.email];
    }
    const kind: MeetingEmailKind =
      type?.name === NOTIFICATION_TYPE.UPDATED
        ? "updated"
        : type?.name === NOTIFICATION_TYPE.CANCELLED
          ? "cancelled"
          : type?.name === NOTIFICATION_TYPE.BUMPED
            ? "bumped"
            : type?.name === NOTIFICATION_TYPE.PREEMPTED
              ? "preempted"
              : "scheduled";

    const preemption =
      kind === "preempted"
        ? await loadPreemptionInfo(tx, row.meeting_id, details.room_id)
        : undefined;

    const bump =
      kind === "bumped"
        ? await loadBumpInfo(tx, row.meeting_id, details.room_id)
        : undefined;

    // While a bumped meeting is pending, only its organizer is asked to act.
    // The attendees hear about the outcome later: an update if the organizer
    // reschedules, a cancellation if they do not.
    if (kind === "bumped" && bump?.deadline) {
      const [organizer] = await tx
        .select({ email: employee.email })
        .from(employee)
        .where(eq(employee.employee_id, details.organizerEmployeeId));

      recipients = organizer?.email ? [organizer.email] : [];
    }

    // A booking confirmation for a recurring series lists every saved
    // occurrence, not just the meeting this row points at (the first one). An
    // edit or cancellation only ever concerns one meeting, so those keep the
    // single-date format.
    let series: SeriesEmailContext | null = null;

    if (isBooking && details.recurringMeetingId !== null) {
      series = await loadSeriesEmailContext(tx, details.recurringMeetingId);

      // Every occurrence was cancelled before this went out: nothing to confirm.
      if (!series) {
        await tx
          .update(notifications)
          .set({ status: "SKIPPED", attempts: row.attempts + 1 })
          .where(eq(notifications.notification_id, notificationId));

        return "SKIPPED" as const;
      }
    }

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
          kind,
          series ?? { bump, preemption }
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
