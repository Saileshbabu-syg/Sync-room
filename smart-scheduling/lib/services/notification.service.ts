import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  employee,
  meeting,
  meeting_attendees,
  meetingTypes,
  notification_type_master,
  notifications,
  reschedule_requests,
  room,
} from "@/db/schema";
import {
  TOP_RANK,
  MAX_DELIVERY_ATTEMPTS,
  MEETING_STATUS,
  NOTIFICATION_TYPE,
} from "@/lib/constants";
import {
  backoffSeconds,
  DELIVERY_LEASE_SECONDS,
  ONLINE_HOLD_RECHECK_SECONDS,
  onlineInviteMaxWaitMinutes,
  isPermanentMailError,
  safeErrorMessage,
} from "@/lib/delivery-policy";
import { invitationLink } from "@/lib/invitation-token";
import type { DbExecutor } from "@/lib/db-types";
import { formatTime } from "@/lib/format";
import { isMeetingEnded, nowInAppTimezone } from "@/lib/time";

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
//   3. delivery CLAIMS the row first (SENDING, under a lease, attempt counted)
//      in its own committed statement, then sends with no database transaction
//      open, then records the result: SENT, SKIPPED (the message no longer
//      applies), PENDING again with an exponential backoff, or FAILED once the
//      attempts are used up or the relay refused it permanently;
//   4. the cron job (processPendingNotifications) retries PENDING rows whose
//      backoff has passed, and takes over rows left SENDING by a worker that
//      died (expired lease).
// Delivery is AT LEAST ONCE: SMTP has no way to make it exactly once, so a
// crash after the relay accepted a message but before SENT was recorded sends
// it again on recovery. Two live workers never send the same row.

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
    deadline: pending ? `${due.date} ${formatTime(due.time)}` : undefined,
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

// The Teams joining link, only while the meeting really is online (a valid
// link is stored together with the flag; see the CHECK on meeting).
function onlineJoinUrl(details: { is_online: boolean; online_join_url: string | null }) {
  return details.is_online && details.online_join_url
    ? details.online_join_url
    : undefined;
}

// Who took the room of a preempted meeting, from the append-only history row.
async function loadPreemptionInfo(
  executor: DbExecutor,
  affectedMeetingId: number,
  roomId: number
): Promise<MeetingPreemptionInfo | undefined> {
  const [history] = await executor
    .select({
      incomingPriority: bookingPriorityHistory.incomingPriority,
    })
    .from(bookingPriorityHistory)
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
    claimedBy:
      history.incomingPriority === TOP_RANK
        ? "a booking with a priority guest"
        : `a higher-priority booking (priority ${history.incomingPriority})`,
    rebookUrl: appUrl ? `${appUrl}/booking` : undefined,
  };
}

export type DeliveryResult = "SENT" | "RETRY" | "FAILED" | "SKIPPED";

type Claim = {
  notification_id: number;
  meeting_id: number;
  notification_type_id: number;
  recipient_employee_id: number | null;
  attempts: number;
  // Waited longer than an online meeting's e-mails may wait for the Teams link.
  hold_expired: boolean;
};

type MeetingDetails = NonNullable<Awaited<ReturnType<typeof getMeetingDetails>>>;

// What to do with a claimed row: send this message, skip it (it no longer
// applies), fail it for good (it can never be delivered), or wait (an online
// meeting whose Teams link is still being created).
type Prepared =
  | { send: () => Promise<unknown> }
  | { skip: string }
  | { fail: string }
  | { defer: string };

// The clock used for claims, leases and backoff: the database's own, unless a
// caller (a test) fixes the moment.
const clock = (now?: Date): SQL =>
  now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

const later = (now: Date | undefined, seconds: number): SQL =>
  sql`${clock(now)} + make_interval(secs => ${seconds})`;

// Claims one notification and COMMITS the claim before anything is sent: a
// single statement flips it to SENDING under a lease and counts the attempt.
// Claimable: PENDING and past its backoff, or SENDING with an expired lease
// (its worker died). SKIP LOCKED + the status change mean two workers can never
// claim the same row.
async function claimNotification(
  notificationId: number,
  now?: Date
): Promise<Claim | null> {
  const result = await db.execute(sql`
    UPDATE notifications
    SET status = 'SENDING',
        attempts = attempts + 1,
        locked_until = ${later(now, DELIVERY_LEASE_SECONDS)}
    WHERE notification_id = (
      SELECT notification_id FROM notifications
      WHERE notification_id = ${notificationId}
        AND (
          (status = 'PENDING' AND next_attempt_at <= ${clock(now)})
          OR (status = 'SENDING' AND locked_until <= ${clock(now)})
        )
        AND attempts < ${MAX_DELIVERY_ATTEMPTS}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING notification_id, meeting_id, notification_type_id,
              recipient_employee_id, attempts,
              (created_at <= ${clock(now)} - make_interval(mins => ${onlineInviteMaxWaitMinutes()})) AS hold_expired
  `);

  return (result.rows[0] ?? null) as Claim | null;
}

// Records the outcome of an attempt. `attempts` fences it: if the lease ran out
// and another worker re-claimed the row meanwhile (attempts moved on), this
// late result is dropped instead of overwriting the newer attempt's.
async function finishNotification(
  claim: Claim,
  values: Record<string, unknown>
) {
  await db
    .update(notifications)
    .set({ locked_until: null, ...values })
    .where(
      and(
        eq(notifications.notification_id, claim.notification_id),
        eq(notifications.status, "SENDING"),
        eq(notifications.attempts, claim.attempts)
      )
    );
}

async function failNotification(
  claim: Claim,
  error: unknown,
  now?: Date
): Promise<DeliveryResult> {
  const reason = safeErrorMessage(error);
  const exhausted =
    isPermanentMailError(error) || claim.attempts >= MAX_DELIVERY_ATTEMPTS;

  console.error(
    `Notification ${claim.notification_id} delivery failed (attempt ${claim.attempts}):`,
    reason
  );

  await finishNotification(
    claim,
    exhausted
      ? { status: "FAILED", last_error: reason }
      : {
          status: "PENDING",
          last_error: reason,
          next_attempt_at: later(now, backoffSeconds(claim.attempts)),
        }
  );

  return exhausted ? "FAILED" : "RETRY";
}

// Whether this message should wait for a Teams link: the meeting (or, for the
// series-wide confirmation and invitations, any upcoming occurrence of its
// series) asked for Teams and its event is still being created or updated.
// Not once the wait limit is reached, and never after provisioning FAILED:
// then the message goes out without a link (the documented fallback) and the
// link follows in an update if it arrives later.
async function awaitingTeams(
  claim: Claim,
  details: MeetingDetails,
  wholeSeries: boolean
) {
  if (claim.hold_expired) return false;

  if (wholeSeries && details.recurringMeetingId !== null) {
    const [pending] = await db
      .select({ id: meeting.meeting_id })
      .from(meeting)
      .where(
        and(
          eq(meeting.recurringMeetingId, details.recurringMeetingId),
          eq(meeting.online_requested, true),
          eq(meeting.online_status, "PENDING"),
          inArray(meeting.meetingStatusId, [
            MEETING_STATUS.SCHEDULED,
            MEETING_STATUS.PENDING_RESCHEDULE,
          ])
        )
      )
      .limit(1);

    return Boolean(pending);
  }

  return details.online_requested && details.online_status === "PENDING";
}

const WAITING_FOR_TEAMS = "Waiting for the Microsoft Teams link.";

// The personal invitation (Accept / Decline links) for one participant.
async function prepareInvitation(
  claim: Claim,
  details: MeetingDetails,
  now: Date
): Promise<Prepared> {
  // Nothing to answer once the meeting is gone.
  if (
    details.meetingStatusId !== MEETING_STATUS.SCHEDULED ||
    isMeetingEnded(details.meeting_date, details.end_time, now)
  ) {
    return { skip: "The meeting is no longer scheduled or has ended." };
  }

  const [recipient] = claim.recipient_employee_id
    ? await db
        .select({
          email: employee.email,
          active: employee.is_active,
          optional: meeting_attendees.is_optional,
        })
        .from(employee)
        .leftJoin(
          meeting_attendees,
          and(
            eq(meeting_attendees.employee_id, employee.employee_id),
            eq(meeting_attendees.meeting_id, claim.meeting_id)
          )
        )
        .where(eq(employee.employee_id, claim.recipient_employee_id))
    : [];

  if (!recipient?.email || !claim.recipient_employee_id) {
    return { fail: "The invited employee has no e-mail address." };
  }

  if (await awaitingTeams(claim, details, true)) return { defer: WAITING_FOR_TEAMS };

  if (!recipient.active) {
    return { skip: "The invited employee is no longer active." };
  }

  const [organizer] = await db
    .select({ name: employee.employee_name })
    .from(employee)
    .where(eq(employee.employee_id, details.organizerEmployeeId));

  const [roomRow] = await db
    .select({ name: room.room_name })
    .from(room)
    .where(eq(room.room_id, details.room_id));

  // Online Teams Meeting: the link of this meeting, and for a series the link
  // of every occurrence (each has its own).
  const joinUrl = onlineJoinUrl(details);
  const occurrenceLinks =
    joinUrl && details.recurringMeetingId !== null
      ? ((await loadSeriesEmailContext(db, details.recurringMeetingId))?.series
          .occurrences ?? [])
          .filter((o) => o.joinUrl)
          .map((o) => ({ date: o.date, joinUrl: o.joinUrl! }))
      : undefined;

  const employeeId = claim.recipient_employee_id;

  return {
    send: () =>
      sendInvitationEmail(recipient.email, {
        title: details.title,
        organizerName: organizer?.name ?? "",
        roomName: roomRow?.name ?? "",
        meetingDate: String(details.meeting_date),
        startTime: String(details.start_time),
        endTime: String(details.end_time),
        acceptUrl: invitationLink(details.meeting_id, employeeId, "accept"),
        declineUrl: invitationLink(details.meeting_id, employeeId, "decline"),
        optional: recipient.optional === true,
        calendar: {
          meetingId: details.meeting_id,
          sequence: details.ics_sequence,
        },
        ...(joinUrl ? { joinUrl, occurrenceLinks } : {}),
        seriesNote:
          details.recurringMeetingId !== null
            ? "This is part of a recurring series. Your answer applies to every occurrence."
            : undefined,
      }),
  };
}

async function roomNameOf(roomId: number) {
  const [row] = await db
    .select({ name: room.room_name })
    .from(room)
    .where(eq(room.room_id, roomId));

  return row?.name;
}

async function organizerEmail(details: MeetingDetails) {
  const [row] = await db
    .select({ email: employee.email })
    .from(employee)
    .where(eq(employee.employee_id, details.organizerEmployeeId));

  return row?.email ?? null;
}

// Builds the message for a claimed row, re-checking that it still applies.
// Reads only; no transaction is held.
async function prepareNotification(claim: Claim, now: Date): Promise<Prepared> {
  const details = await getMeetingDetails(claim.meeting_id);

  if (!details) return { fail: "The meeting no longer exists." };

  const [type] = await db
    .select({ name: notification_type_master.notification_type_name })
    .from(notification_type_master)
    .where(
      eq(notification_type_master.notification_type_id, claim.notification_type_id)
    );

  if (type?.name === NOTIFICATION_TYPE.INVITED) {
    return prepareInvitation(claim, details, now);
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

  const isBooking = type?.name === NOTIFICATION_TYPE.BOOKED;
  const isSeriesBooking = isBooking && details.recurringMeetingId !== null;

  // A confirmation or an update only makes sense while the meeting still
  // happens: a row queued before a cancellation, a replacement or the end of
  // the meeting is skipped, not sent stale. (A series confirmation is checked
  // against the whole series below: one cancelled occurrence does not stop it.)
  if (
    (kind === "updated" || (isBooking && !isSeriesBooking)) &&
    (details.meetingStatusId !== MEETING_STATUS.SCHEDULED ||
      isMeetingEnded(details.meeting_date, details.end_time, now))
  ) {
    return {
      skip: `The meeting is no longer scheduled or has ended; the ${kind === "updated" ? "update" : "confirmation"} was not sent.`,
    };
  }

  // Confirmations, invitations and updates of an online meeting carry its
  // Teams link and calendar entry: wait (briefly) until it exists.
  if (
    (isBooking || kind === "updated") &&
    (await awaitingTeams(claim, details, isSeriesBooking))
  ) {
    return { defer: WAITING_FOR_TEAMS };
  }

  let recipients: string[];

  if (isBooking) {
    // The organizer gets the booking confirmation; every other participant
    // gets their own invitation (prepareInvitation) instead of a copy of it.
    const email = await organizerEmail(details);
    recipients = email ? [email] : [];
  } else {
    // An update is for people who are coming; news that the meeting is off
    // reaches everyone invited.
    recipients = (
      await getMeetingAttendees(claim.meeting_id, db, {
        excludeDeclined: kind === "updated",
      })
    )
      .map((a) => a.email)
      .filter((email): email is string => Boolean(email));
  }

  const preemption =
    kind === "preempted"
      ? await loadPreemptionInfo(db, claim.meeting_id, details.room_id)
      : undefined;

  const bump =
    kind === "bumped"
      ? await loadBumpInfo(db, claim.meeting_id, details.room_id)
      : undefined;

  // While a bumped meeting is pending, only its organizer is asked to act.
  // The attendees hear about the outcome later: an update if the organizer
  // reschedules, a cancellation if they do not.
  if (kind === "bumped" && bump?.deadline) {
    const email = await organizerEmail(details);
    recipients = email ? [email] : [];
  }

  // A booking confirmation for a recurring series lists every saved
  // occurrence, not just the meeting this row points at (the first one). An
  // edit or cancellation only ever concerns one meeting, so those keep the
  // single-date format.
  let series: SeriesEmailContext | null = null;

  if (isSeriesBooking) {
    series = await loadSeriesEmailContext(db, details.recurringMeetingId!);

    if (!series) {
      return { skip: "Every occurrence was cancelled before this went out." };
    }
  }

  return {
    send: async () => {
      if (recipients.length === 0) return;

      // One message to all recipients (Bcc when there are several): delivery
      // is all-or-nothing, so a retry can never re-send to part of the list.
      await sendMeetingEmail(
        recipients,
        details.title,
        String(details.meeting_date),
        String(details.start_time),
        String(details.end_time),
        kind,
        series ?? {
          bump,
          preemption,
          roomName: await roomNameOf(details.room_id),
          calendar: {
            meetingId: details.meeting_id,
            sequence: details.ics_sequence,
          },
          ...(onlineJoinUrl(details)
            ? { online: { joinUrl: onlineJoinUrl(details)! } }
            : {}),
        }
      );
    },
  };
}

// Delivers one notification: claim (committed), prepare, send with no
// transaction open, record. Returns SKIPPED without doing anything when the row
// is not claimable (already handled, backing off, or another live worker has
// it).
export async function deliverNotification(
  notificationId: number,
  now?: Date
): Promise<DeliveryResult> {
  const claim = await claimNotification(notificationId, now);

  if (!claim) return "SKIPPED";

  let prepared: Prepared;

  try {
    prepared = await prepareNotification(claim, now ?? new Date());
  } catch (error) {
    return failNotification(claim, error, now);
  }

  if ("skip" in prepared) {
    await finishNotification(claim, { status: "SKIPPED", last_error: prepared.skip });

    return "SKIPPED";
  }

  if ("defer" in prepared) {
    // Back to the queue for a later look, without using up an attempt.
    await finishNotification(claim, {
      status: "PENDING",
      attempts: claim.attempts - 1,
      next_attempt_at: later(now, ONLINE_HOLD_RECHECK_SECONDS),
      last_error: prepared.defer,
    });

    return "SKIPPED";
  }

  if ("fail" in prepared) {
    console.error(`Notification ${claim.notification_id} cannot be delivered: ${prepared.fail}`);
    await finishNotification(claim, { status: "FAILED", last_error: prepared.fail });

    return "FAILED";
  }

  try {
    await prepared.send();
  } catch (error) {
    return failNotification(claim, error, now);
  }

  await finishNotification(claim, {
    status: "SENT",
    sent_at: new Date(),
    last_error: null,
  });

  return "SENT";
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

// Parks notifications whose worker died during their LAST allowed attempt: the
// outcome of that send is unknown, and retrying would exceed the limit.
async function failAbandonedNotifications(now?: Date) {
  await db
    .update(notifications)
    .set({
      status: "FAILED",
      locked_until: null,
      last_error:
        "The worker stopped during the final attempt; delivery outcome unknown.",
    })
    .where(
      and(
        eq(notifications.status, "SENDING"),
        lte(notifications.locked_until, clock(now)),
        gte(notifications.attempts, MAX_DELIVERY_ATTEMPTS)
      )
    );
}

// Cron retry pass: picks up PENDING rows whose backoff has passed and rows left
// SENDING by a worker that died. `minAgeSeconds` leaves fresh rows to their own
// immediate attempt. `now` fixes the clock (tests); by default the database's.
export async function processPendingNotifications(
  minAgeSeconds = 30,
  limit = 50,
  now?: Date
) {
  await failAbandonedNotifications(now);

  const due = await db
    .select({ id: notifications.notification_id })
    .from(notifications)
    .where(
      and(
        or(
          and(
            eq(notifications.status, "PENDING"),
            lte(notifications.next_attempt_at, clock(now)),
            sql`${notifications.created_at} <= now() - make_interval(secs => ${minAgeSeconds})`
          ),
          and(
            eq(notifications.status, "SENDING"),
            lte(notifications.locked_until, clock(now))
          )
        ),
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
    summary[await deliverNotification(id, now)]++;
  }

  return summary;
}
