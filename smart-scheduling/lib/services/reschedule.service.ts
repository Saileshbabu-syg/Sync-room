import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  meeting,
  reminder_logs,
  reschedule_requests,
  roles,
  room,
} from "@/db/schema";
import {
  APP_TIMEZONE,
  AVAILABILITY_STATUS,
  MEETING_STATUS,
  PERMISSION,
  REMINDER_LEAD_MINUTES,
  ROLE_ADMIN,
} from "@/lib/constants";
import type { Tx } from "@/lib/db-types";
import {
  isMeetingEnded,
  isSlotStartInPast,
  normalizeTime,
  nowInAppTimezone,
  timeToSeconds,
} from "@/lib/time";
import {
  LEAD_TIME_MESSAGE,
  MIN_DURATION_MESSAGE,
  hasMinimumLead,
  isLongEnough,
  isWithinBookingWindow,
} from "@/lib/validations/date-time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import {
  checkBookingLimits,
  effectiveLimitsForGroup,
  lockGroupBookings,
} from "./booking-limits.service";
import { checkBookingPolicy, getBookingPolicy } from "./booking-policy.service";
import { findConflictingDates } from "./conflict-check.service";
import { getPriorityContext } from "./group-context.service";
import { findSlotHolders } from "./priority.service";
import { isMeetingTypeAllowed } from "./meeting-type-access.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";
import {
  dispatchOnlineProvisioning,
  requestOnlineSync,
} from "./online-meeting.service";

// Moves a meeting to another room, date or time: a scheduled meeting (B-04),
// or a bumped one (status PENDING_RESCHEDULE) before it is cancelled
// automatically. The new slot
// must be free: a reschedule never bumps anyone (so priority and protected
// meetings are never affected), and it must pass the same rules as a new
// booking (duration, booking window, the organizer's group policy and meeting
// type). Every check runs before anything is written, inside one transaction,
// so a refused move leaves the meeting exactly as it was. On success the
// meeting is Scheduled (again), its calendar entry gets a new version, a
// pending reschedule request is closed and every attendee is told about the
// change (through the outbox, after commit). Attendees and their answers are
// untouched.

export const ROOM_LOCK_NAMESPACE = 7001;

export class RescheduleError extends Error {
  status: number;
  // Why, when the slot is taken: which meeting holds it and which rule applies.
  details: Record<string, unknown>;

  constructor(message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RescheduleError";
    this.status = status;
    this.details = details;
  }
}

export type RescheduleInput = {
  meetingId: number;
  actor: { employeeId: number; role: string };
  roomId: number;
  meetingDate: string;
  startTime: string;
  endTime: string;
  // Test hooks.
  now?: Date;
  notify?: boolean;
};

export type MoveTarget = {
  roomId: number;
  meetingDate: string;
  startTime: string;
  endTime: string;
};

// Normalised times, or an error for a slot no booking could have: malformed,
// end before start, shorter than 15 minutes.
export function normalizeSlot(target: MoveTarget): MoveTarget {
  let startTime: string;
  let endTime: string;

  try {
    startTime = normalizeTime(target.startTime);
    endTime = normalizeTime(target.endTime);
  } catch {
    throw new RescheduleError("Invalid start or end time", 400);
  }

  if (timeToSeconds(startTime) === timeToSeconds(endTime)) {
    throw new RescheduleError("End time must be different from the start time", 400);
  }

  if (!isLongEnough(startTime, endTime)) {
    throw new RescheduleError(MIN_DURATION_MESSAGE, 400);
  }

  return {
    roomId: target.roomId,
    meetingDate: target.meetingDate,
    startTime,
    endTime,
  };
}

// Only the meeting's organizer or an Admin (current role) may change it (B-10;
// there is deliberately no separate edit permission).
export function assertMayChange(
  existing: { organizerEmployeeId: number },
  actor: { employeeId: number; role: string }
) {
  if (
    existing.organizerEmployeeId !== actor.employeeId &&
    actor.role !== ROLE_ADMIN
  ) {
    throw new RescheduleError(
      "You do not have permission to change this meeting.",
      403
    );
  }
}

// Moves one locked meeting row to `target`, inside the caller's transaction,
// after checking everything a new booking by its organizer would need. The
// caller holds the target room's advisory lock (taken BEFORE the meeting row,
// the same order as booking) and the meeting row lock. Nothing is written until
// every check passed, so a refusal leaves the meeting as it was. Does not queue
// notifications (the caller does). Returns the target room's name.
export async function moveLockedMeeting(
  tx: Tx,
  existing: typeof meeting.$inferSelect,
  target: MoveTarget,
  actorEmployeeId: number,
  now: Date | undefined,
  // The 3-month booking window: applied to a single move; a series edit
  // applies it to the series' first occurrence only (B-05).
  checkWindow = true
) {
  const { roomId, meetingDate, startTime, endTime } = target;

  if (
    existing.meetingStatusId !== MEETING_STATUS.SCHEDULED &&
    existing.meetingStatusId !== MEETING_STATUS.PENDING_RESCHEDULE
  ) {
    throw new RescheduleError(
      "Only a scheduled meeting, or one waiting to be rescheduled, can be moved.",
      400
    );
  }

  if (
    existing.meetingStatusId === MEETING_STATUS.SCHEDULED &&
    isMeetingEnded(existing.meeting_date, existing.start_time, existing.end_time, now)
  ) {
    throw new RescheduleError(
      "Meetings that have already ended cannot be moved.",
      400
    );
  }

  if (isSlotStartInPast(meetingDate, startTime, now)) {
    throw new RescheduleError("Meetings cannot be moved to the past", 400);
  }

  // At least 15 minutes ahead (B-09), checked under the locks, right before
  // the write.
  if (!hasMinimumLead(meetingDate, startTime, now)) {
    throw new RescheduleError(LEAD_TIME_MESSAGE, 400);
  }

  if (checkWindow && !isWithinBookingWindow(meetingDate, now)) {
    throw new RescheduleError(
      "meeting_date must be between today and 3 months from today",
      400
    );
  }

  const [roomDetails] = await tx
    .select()
    .from(room)
    .where(eq(room.room_id, roomId))
    .for("share");

  if (!roomDetails) throw new RescheduleError("Room not found.", 404);

  if (roomDetails.archived_at !== null) {
    throw new RescheduleError(
      "This room has been archived and can no longer be booked.",
      409
    );
  }

  if (roomDetails.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE) {
    throw new RescheduleError(
      "This room is currently unavailable for booking.",
      409
    );
  }

  // The new slot must satisfy the same rules as a new booking by the
  // meeting's organizer (whose booking it stays): permission to book, the
  // group's room list, longest meeting and days ahead, and the meeting type.
  // Read under the room lock, like a booking.
  const [organizer] = await tx
    .select({ role: roles.roleName })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(eq(employee.employee_id, existing.organizerEmployeeId));

  const standing = await getPriorityContext(existing.organizerEmployeeId, tx);

  if (!standing.permissions.has(PERMISSION.BOOKING_CREATE)) {
    throw new RescheduleError(
      "The organizer's group is not allowed to create bookings.",
      403
    );
  }

  const policyProblem = checkBookingPolicy(
    await getBookingPolicy(existing.organizerEmployeeId, tx, standing),
    {
      roomId,
      startTime,
      endTime,
      occurrenceDates: [meetingDate],
      // One meeting moves, even if it belongs to a series.
      isSeries: false,
    },
    nowInAppTimezone(now).date
  );

  if (policyProblem) {
    throw new RescheduleError(policyProblem.message, policyProblem.status);
  }

  // The group's day / week / month allowance. A move is not a new booking: the
  // meeting is left out of the count, and a period that still contains the date
  // it leaves gains nothing, so only a move to a different day, week or month
  // can be refused. The allowance belongs to the group the meeting was booked
  // under, even if its organizer has since changed group. A move that keeps the
  // date (every series edit) changes no period and needs no check. The caller
  // holds the group lock when the date can change (rescheduleMeeting).
  if (existing.groupIdAtBooking !== null && meetingDate !== existing.meeting_date) {
    const limitProblem = await checkBookingLimits(tx, {
      groupId: existing.groupIdAtBooking,
      limits: await effectiveLimitsForGroup(existing.groupIdAtBooking, tx),
      dates: [meetingDate],
      moving: { meetingId: existing.meeting_id, fromDate: existing.meeting_date },
    });

    if (limitProblem) {
      throw new RescheduleError(limitProblem.message, limitProblem.status);
    }
  }

  if (
    !(await isMeetingTypeAllowed(
      {
        employeeId: existing.organizerEmployeeId,
        roleName: organizer?.role ?? "",
      },
      existing.meetingTypeId,
      tx
    ))
  ) {
    throw new RescheduleError(
      "The organizer's group is not allowed to book this meeting type.",
      403
    );
  }

  // Never bumps anyone: the slot must be free of every other meeting. The
  // meeting itself is left out (it may move within its own slot); the EXCLUDE
  // constraint backs this up when the row is updated.
  const conflicts = await findConflictingDates(
    tx,
    roomId,
    [meetingDate],
    startTime,
    endTime,
    [existing.meeting_id]
  );

  if (conflicts.length > 0) {
    // Say which meeting is in the way. A move is never allowed to replace
    // anyone, whatever the priorities (the same for one meeting and for every
    // occurrence of a series), so the reason is that rule plus the holder.
    const holders = await findSlotHolders(
      tx,
      roomId,
      [meetingDate],
      startTime,
      endTime
    );
    const inTheWay = holders.filter((h) => h.meetingId !== existing.meeting_id);
    const reason =
      `${meetingDate} ${startTime.slice(0, 5)}-${endTime.slice(0, 5)}: moving a meeting never replaces another booking, ` +
      `and the slot is held by ` +
      (inTheWay.length > 0
        ? inTheWay.map((h) => `"${h.title}"`).join(", ")
        : "another meeting") +
      ".";

    throw new RescheduleError(
      "Room is already booked for the selected time slot",
      409,
      {
        reason,
        conflicts: [meetingDate],
        heldBy: inTheWay.map((h) => h.meetingId),
      }
    );
  }

  const wasPending =
    existing.meetingStatusId === MEETING_STATUS.PENDING_RESCHEDULE;

  await tx
    .update(meeting)
    .set({
      room_id: roomId,
      meeting_date: meetingDate,
      start_time: startTime,
      end_time: endTime,
      meetingStatusId: MEETING_STATUS.SCHEDULED,
      // The calendar entry moves: a new version, under the row lock.
      ics_sequence: sql`${meeting.ics_sequence} + 1`,
      updated_at: new Date(),
    })
    .where(eq(meeting.meeting_id, existing.meeting_id));

  // Its Teams event (if any) follows: same event and link, updated by the
  // background worker after the commit.
  await requestOnlineSync(tx, [existing.meeting_id]);

  if (wasPending) {
    await tx
      .update(reschedule_requests)
      .set({ status: "RESCHEDULED", resolved_at: new Date() })
      .where(
        and(
          eq(reschedule_requests.bumped_meeting_id, existing.meeting_id),
          eq(reschedule_requests.status, "PENDING")
        )
      );
  }

  // The reminder follows the new start time (and is re-armed).
  await tx
    .update(reminder_logs)
    .set({
      status: "PENDING",
      attempts: 0,
      next_attempt_at: sql`now()`,
      locked_until: null,
      last_error: null,
      reminder_time: sql`GREATEST(
        ((${meetingDate}::date + ${startTime}::time) AT TIME ZONE ${APP_TIMEZONE}::text)
          - make_interval(mins => ${REMINDER_LEAD_MINUTES}),
        now()
      )`,
    })
    .where(eq(reminder_logs.meeting_id, existing.meeting_id));

  await createAuditLog(
    existing.meeting_id,
    AUDIT_ACTION.RESCHEDULED,
    `${wasPending ? "Rescheduled" : "Moved"} to ${roomDetails.room_name} on ${meetingDate} ${startTime}-${endTime}`,
    actorEmployeeId,
    tx
  );

  return roomDetails.room_name;
}

// Moves one meeting (B-04: a scheduled meeting, or a bumped one waiting to be
// rescheduled) to another room, date or time. Only its organizer or an Admin
// may (B-10). Same meeting id, organizer, attendees and answers, calendar UID
// and Teams event; the calendar version rises; attendees get an update after
// the commit, and the Teams event is moved after the commit.
export async function rescheduleMeeting(input: RescheduleInput) {
  const target = normalizeSlot(input);

  const notificationId = await db.transaction(async (tx) => {
    // Same lock order as booking (room first, then the group's allowance), then
    // the meeting row.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, ${target.roomId})`
    );

    const [booked] = await tx
      .select({ groupId: meeting.groupIdAtBooking })
      .from(meeting)
      .where(eq(meeting.meeting_id, input.meetingId));

    if (booked?.groupId != null) await lockGroupBookings(tx, booked.groupId);

    const [existing] = await tx
      .select()
      .from(meeting)
      .where(eq(meeting.meeting_id, input.meetingId))
      .for("update");

    if (!existing) throw new RescheduleError("Meeting not found.", 404);

    assertMayChange(existing, input.actor);

    await moveLockedMeeting(
      tx,
      existing,
      target,
      input.actor.employeeId,
      input.now
    );

    return queueMeetingNotification(tx, input.meetingId, "UPDATED");
  });

  if (input.notify !== false) dispatchNotification(notificationId);

  // The Teams event (same event, same link) is moved by the background
  // worker; a failure there is retried and never undoes the move.
  dispatchOnlineProvisioning();

  return { notificationId };
}
