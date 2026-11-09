import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  type Meeting,
  meeting,
  meeting_attendees,
  meetingTypes,
  recurrence_frequency_master,
  recurringMeetingSkippedDates,
  recurring_meetings,
  room,
} from "@/db/schema";
import {
  AVAILABILITY_STATUS,
  MEETING_STATUS,
  PERMISSION,
} from "@/lib/constants";
import { dbErrorCode, PG_EXCLUSION_VIOLATION } from "@/lib/api";
import type { DbExecutor, Tx } from "@/lib/db-types";
import {
  LEAD_TIME_MESSAGE,
  MIN_DURATION_MESSAGE,
  hasMinimumLead,
  isLongEnough,
} from "@/lib/validations/date-time";
import {
  isSlotStartInPast,
  normalizeTime,
  nowInAppTimezone,
  timeToSeconds,
} from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { findConflictingDates } from "./conflict-check.service";
import { isMeetingTypeAllowed } from "./meeting-type-access.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";
import { getPriorityContext } from "./group-context.service";
import { checkBookingLimits, lockGroupBookings } from "./booking-limits.service";
import { checkBookingPolicy, getBookingPolicy } from "./booking-policy.service";
import {
  PRIORITY_BLOCK,
  claimantRank,
  describePriorityConflicts,
  findSlotHolders,
  hasMemberWithPermission,
  recordBumps,
  releaseSlots,
  summarizePriorityConflicts,
  type PriorityConflict,
  type ReleasedSlot,
} from "./priority.service";
import { createRemindersForMeetings } from "./reminder.service";
import {
  ONLINE_STATUS,
  dispatchOnlineCleanup,
  dispatchOnlineProvisioning,
  pendingOnlineOutcome,
  type OnlineBookingOutcome,
} from "./online-meeting.service";

// The single place meetings are created — one-off and recurring bookings both
// come through here, so they share one set of rules:
//
//  * Slots are half-open [start, end): back-to-back meetings are allowed,
//    genuine overlaps in the same room are not (cancelled meetings don't count).
//  * All checks and all inserts run in ONE transaction, serialised per room by
//    an advisory lock and backed by the `meeting_no_room_overlap` EXCLUDE
//    constraint. Two concurrent requests for the same slot can therefore never
//    both succeed, and a recurring series is all-or-nothing.
//  * The room row is read with FOR SHARE inside that transaction, so the
//    availability check sees the current status and a concurrent
//    "set room to maintenance" update waits for the booking (and vice versa).
//  * Priority: the organizer's CURRENT group and permissions are read from the
//    database under the room lock (never from the client). A slot held only by
//    confirmed, not-yet-started meetings of strictly lower group priority (see
//    priority.service) is taken over instead of rejected: those meetings become
//    PREEMPTED in the same transaction, with history rows, and their attendees
//    are e-mailed. The group and priority used are stored on the new meetings.

// The message for "this single slot is taken".
export const SLOT_TAKEN_MESSAGE = "Room is already booked for the selected time slot";

// A meeting in the way includes someone whose group protects its meetings, so
// no booking can take the room, whatever its priority.
export const PROTECTED_SLOT_MESSAGE =
  "Room is held by a protected meeting (it includes a member whose group protects its meetings) and cannot be taken over. Choose another room or time.";

export class BookingError extends Error {
  status: number;
  conflicts?: string[];
  // Every date the series would have used, so the caller can show which
  // occurrences are free and which are taken.
  occurrenceDates?: string[];
  // Present when priority is why the room could not be taken: one entry per
  // meeting in the way (every occurrence of a series is checked), each with
  // the priority condition that decided it.
  priorityConflicts?: PriorityConflict[];

  constructor(
    message: string,
    status: number,
    conflicts?: string[],
    occurrenceDates?: string[],
    priorityConflicts?: PriorityConflict[]
  ) {
    super(message);
    this.name = "BookingError";
    this.status = status;
    this.conflicts = conflicts;
    this.occurrenceDates = occurrenceDates;
    this.priorityConflicts = priorityConflicts;
  }

  // Why, in words (the message itself stays the same short sentence).
  get reason(): string | undefined {
    return this.priorityConflicts && this.priorityConflicts.length > 0
      ? summarizePriorityConflicts(this.priorityConflicts)
      : undefined;
  }

  // The extra fields every booking API sends with a refusal.
  get details() {
    return {
      ...(this.conflicts ? { conflicts: this.conflicts } : {}),
      ...(this.conflicts && this.occurrenceDates
        ? { occurrenceDates: this.occurrenceDates }
        : {}),
      ...(this.priorityConflicts && this.priorityConflicts.length > 0
        ? { reason: this.reason, priorityConflicts: this.priorityConflicts }
        : {}),
    };
  }
}

// Namespace for the per-room advisory lock (first key of the two-int form).
const ROOM_LOCK_NAMESPACE = 7001;

export type BookingInput = {
  title: string;
  roomId: number;
  // One date for a normal booking, one per occurrence for a series.
  occurrenceDates: string[];
  startTime: string;
  endTime: string;
  organizerEmployeeId: number;
  // Current role of the organizer (drives which meeting types are allowed).
  organizerRole: string;
  participantCount: number;
  meetingTypeId: number;
  participantEmployeeIds?: number[];
  // Invited, but not essential: they get the same invitation (marked optional)
  // and their answer never affects the booking.
  optionalParticipantEmployeeIds?: number[];
  recurrence?: {
    frequencyId: number;
    occurrenceCount: number;
    // The pattern and its exceptions (stored on the new series).
    patternStartDate?: string;
    interval?: number;
    untilDate?: string | null;
    skippedDates?: string[];
    // Add these occurrences to an EXISTING series instead of creating one
    // (extending a series); its row must already be locked by the caller.
    appendToSeriesId?: number;
  };
  // How many occurrences the user asked for (some may be skipped later), for
  // the group's series-length limit.
  requestedOccurrences?: number;
  // Online Teams Meeting: every occurrence is booked with Teams provisioning
  // PENDING; the background worker creates one Teams event per occurrence
  // after the commit (never inside it, never in the request). The e-mails are
  // queued with the booking and wait for the links (online-meeting.service).
  // The booking never depends on Microsoft being reachable.
  online?: boolean;
  // Runs inside the booking transaction, after the meetings are inserted; if
  // it throws, the whole booking rolls back.
  inTransaction?: (tx: Tx, meetings: Meeting[]) => Promise<void>;
  // Test hooks.
  now?: Date;
  notify?: boolean;
};

export async function createBooking(input: BookingInput) {
  const isSeries = input.recurrence !== undefined;

  let startTime: string;
  let endTime: string;

  try {
    startTime = normalizeTime(input.startTime);
    endTime = normalizeTime(input.endTime);
  } catch {
    throw new BookingError("Invalid start or end time", 400);
  }

  if (timeToSeconds(startTime) === timeToSeconds(endTime)) {
    throw new BookingError("End time must be different from the start time", 400);
  }

  // Same rule as the request schemas, for every caller of the service.
  if (!isLongEnough(startTime, endTime)) {
    throw new BookingError(MIN_DURATION_MESSAGE, 400);
  }

  if (input.occurrenceDates.length === 0) {
    throw new BookingError("At least one meeting date is required", 400);
  }

  if (isSlotStartInPast(input.occurrenceDates[0], startTime, input.now)) {
    throw new BookingError("Meetings cannot be booked in the past", 400);
  }

  // The organizer is always included and counted once, so listing them as a
  // participant as well neither counts twice nor changes anything (the edit
  // route treats it the same way).
  const requestedAttendees = [
    ...new Set(input.participantEmployeeIds ?? []),
  ].filter((id) => id !== input.organizerEmployeeId);
  const optionalAttendees = [
    ...new Set(input.optionalParticipantEmployeeIds ?? []),
  ];
  const maximumAttendees = input.participantCount - 1;

  // One person, one list: never both, and never the organizer (who is always
  // included).
  if (
    optionalAttendees.some(
      (id) =>
        id === input.organizerEmployeeId || requestedAttendees.includes(id)
    )
  ) {
    throw new BookingError(
      "An employee cannot be both a participant and an optional participant.",
      400
    );
  }

  // Organizer is counted as one participant, so everyone else (mandatory and
  // optional together) can only be participant_count - 1.
  if (requestedAttendees.length + optionalAttendees.length > maximumAttendees) {
    throw new BookingError(
      `You can add only ${maximumAttendees} attendee(s). The organizer is counted automatically.`,
      400
    );
  }

  const attendeeIds = [
    ...new Set([
      input.organizerEmployeeId,
      ...requestedAttendees,
      ...optionalAttendees,
    ]),
  ];
  const optionalSet = new Set(optionalAttendees);

  let result;

  try {
    result = await db.transaction(async (tx) => {
      // Serialise bookings of the same room; other rooms proceed in parallel.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, ${input.roomId})`
      );

      // At least 15 minutes ahead (B-09), checked now that the room is locked,
      // i.e. right before the booking is written.
      if (!hasMinimumLead(input.occurrenceDates[0], startTime, input.now)) {
        throw new BookingError(LEAD_TIME_MESSAGE, 400);
      }

      const [roomDetails] = await tx
        .select()
        .from(room)
        .where(eq(room.room_id, input.roomId))
        .for("share");

      if (!roomDetails) {
        throw new BookingError("Room not found", 404);
      }

      // Current status, read under lock — not whatever the page showed earlier.
      // Archived rooms are kept only for the meetings held in them.
      if (roomDetails.archived_at !== null) {
        throw new BookingError(
          "This room has been archived and can no longer be booked.",
          409
        );
      }

      if (roomDetails.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE) {
        throw new BookingError(
          "This room is currently unavailable for booking.",
          409
        );
      }

      // Headcount above the room's capacity is allowed on purpose: the booking
      // screen only warns the organizer, it never blocks the booking.

      // Trusted standing of the organizer, read under the room lock.
      const claimant = await getPriorityContext(input.organizerEmployeeId, tx);

      if (!claimant.permissions.has(PERMISSION.BOOKING_CREATE)) {
        throw new BookingError(
          "Your group is not allowed to create bookings.",
          403
        );
      }

      // The group's own rules: room list, recurring permission, longest
      // meeting, how far ahead, series length. Read under the room lock.
      const bookingPolicy = await getBookingPolicy(
        input.organizerEmployeeId,
        tx,
        claimant
      );
      const policyProblem = checkBookingPolicy(
        bookingPolicy,
        {
          roomId: input.roomId,
          startTime,
          endTime,
          occurrenceDates: input.occurrenceDates,
          isSeries,
          requestedOccurrences: input.requestedOccurrences,
        },
        nowInAppTimezone(input.now).date
      );

      if (policyProblem) {
        throw new BookingError(policyProblem.message, policyProblem.status);
      }

      // The group's day / week / month allowance. The group lock (taken after
      // the room lock, always in that order) makes the count and the insert
      // below one step, so concurrent requests cannot both take the last
      // place. Every occurrence of a series is counted together, and the whole
      // booking is refused (nothing is written) if any period would overflow.
      if (claimant.groupId !== null) {
        await lockGroupBookings(tx, claimant.groupId);
      }

      const limitProblem = await checkBookingLimits(tx, {
        groupId: claimant.groupId,
        limits: bookingPolicy.limits,
        dates: input.occurrenceDates,
        isSeries,
      });

      if (limitProblem) {
        throw new BookingError(limitProblem.message, limitProblem.status);
      }

      const [meetingTypeRow] = await tx
        .select({
          id: meetingTypes.meetingTypeId,
          priorityRank: meetingTypes.priorityRank,
        })
        .from(meetingTypes)
        .where(eq(meetingTypes.meetingTypeId, input.meetingTypeId));

      if (!meetingTypeRow) {
        throw new BookingError("Meeting type not found", 404);
      }

      // The meeting type decides priority for every meeting, except that
      // inviting anyone from Leadership (required or optional) outranks all.
      const rank = claimantRank(
        meetingTypeRow.priorityRank,
        await hasMemberWithPermission(tx, attendeeIds, PERMISSION.BOOKING_OUTRANKS)
      );

      if (
        !(await isMeetingTypeAllowed(
          {
            employeeId: input.organizerEmployeeId,
            roleName: input.organizerRole,
          },
          input.meetingTypeId,
          tx
        ))
      ) {
        throw new BookingError(
          "Your group is not allowed to book this meeting type.",
          403
        );
      }

      if (input.recurrence) {
        const [frequency] = await tx
          .select({ id: recurrence_frequency_master.frequency_id })
          .from(recurrence_frequency_master)
          .where(
            eq(
              recurrence_frequency_master.frequency_id,
              input.recurrence.frequencyId
            )
          );

        if (!frequency) {
          throw new BookingError("Recurrence frequency not found", 404);
        }
      }

      const existingAttendees = await tx
        .select({ id: employee.employee_id })
        .from(employee)
        .where(inArray(employee.employee_id, attendeeIds));

      if (existingAttendees.length !== attendeeIds.length) {
        throw new BookingError("One or more attendees not found", 404);
      }

      const conflictingDates = await findConflictingDates(
        tx,
        input.roomId,
        input.occurrenceDates,
        startTime,
        endTime
      );

      let released: ReleasedSlot[] = [];

      if (conflictingDates.length > 0) {
        const holders = await findSlotHolders(
          tx,
          input.roomId,
          input.occurrenceDates,
          startTime,
          endTime
        );

        // Only a booking that outranks EVERY other meeting in the way, on
        // EVERY occurrence, may proceed. The same evaluation serves a single
        // date and a series, and says which condition stopped it.
        const priorityConflicts = describePriorityConflicts(
          holders,
          rank,
          input.now
        );

        if (priorityConflicts.length > 0) {
          const blockedByProtected = priorityConflicts.some(
            (c) => c.code === PRIORITY_BLOCK.PROTECTED_MEETING
          );

          throw new BookingError(
            blockedByProtected
              ? PROTECTED_SLOT_MESSAGE
              : isSeries
                ? "Room is already booked for one or more occurrences"
                : SLOT_TAKEN_MESSAGE,
            409,
            isSeries ? conflictingDates : undefined,
            isSeries ? input.occurrenceDates : undefined,
            priorityConflicts
          );
        }

        released = await releaseSlots(tx, holders);
      }

      let recurringMeetingId: number | null = null;

      if (input.recurrence?.appendToSeriesId !== undefined) {
        recurringMeetingId = input.recurrence.appendToSeriesId;
      } else if (input.recurrence) {
        const [series] = await tx
          .insert(recurring_meetings)
          .values({
            frequency_id: input.recurrence.frequencyId,
            occurrence_count: input.recurrence.occurrenceCount,
            recurrence_end_date:
              input.occurrenceDates[input.occurrenceDates.length - 1],
            pattern_start_date:
              input.recurrence.patternStartDate ?? input.occurrenceDates[0],
            recurrence_interval: input.recurrence.interval ?? 1,
            until_date: input.recurrence.untilDate ?? null,
          })
          .returning();

        recurringMeetingId = series.recurring_meeting_id;

        // Dates of the pattern deliberately left out: never re-created.
        if (input.recurrence.skippedDates?.length) {
          await tx.insert(recurringMeetingSkippedDates).values(
            input.recurrence.skippedDates.map((skippedDate) => ({
              recurringMeetingId: series.recurring_meeting_id,
              skippedDate,
            }))
          );
        }
      }

      const insertedMeetings = await tx
        .insert(meeting)
        .values(
          input.occurrenceDates.map((occurrenceDate) => ({
            title: input.title,
            room_id: input.roomId,
            meeting_date: occurrenceDate,
            organizerEmployeeId: input.organizerEmployeeId,
            participantCount: input.participantCount,
            meetingTypeId: input.meetingTypeId,
            // Always SCHEDULED on creation; a client-supplied status is never
            // trusted.
            meetingStatusId: MEETING_STATUS.SCHEDULED,
            start_time: startTime,
            end_time: endTime,
            recurringMeetingId,
            // Snapshot of the standing used for this booking; later group or
            // priority changes never rewrite it.
            groupIdAtBooking: claimant.groupId,
            priorityAtBooking: claimant.priority,
            online_requested: input.online === true,
            ...(input.online
              ? {
                  online_status: ONLINE_STATUS.PENDING,
                  online_version: 1,
                  online_next_attempt_at: new Date(),
                }
              : {}),
          }))
        )
        .returning();

      insertedMeetings.sort((a, b) =>
        a.meeting_date.localeCompare(b.meeting_date)
      );

      const bumpNotificationIds = await recordBumps(
        tx,
        released,
        insertedMeetings.map((m) => ({
          meetingId: m.meeting_id,
          meetingDate: m.meeting_date,
        })),
        {
          actorEmployeeId: input.organizerEmployeeId,
          groupId: claimant.groupId,
          groupName: claimant.groupName,
          priority: rank,
        }
      );

      await tx.insert(meeting_attendees).values(
        insertedMeetings.flatMap((m) =>
          attendeeIds.map((employeeId) => ({
            meeting_id: m.meeting_id,
            employee_id: employeeId,
            // The organizer needs no invitation; everyone else starts without
            // an answer.
            response_status:
              employeeId === input.organizerEmployeeId
                ? "ACCEPTED"
                : "NO_RESPONSE",
            is_optional: optionalSet.has(employeeId),
          }))
        )
      );

      if (input.inTransaction) {
        await input.inTransaction(tx, insertedMeetings);
      }

      await createRemindersForMeetings(
        tx,
        insertedMeetings.map((m) => m.meeting_id)
      );

      for (const m of insertedMeetings) {
        await createAuditLog(
          m.meeting_id,
          AUDIT_ACTION.CREATED,
          `Booked ${roomDetails.room_name} on ${m.meeting_date} ${startTime}-${endTime}` +
            (recurringMeetingId ? ` (series #${recurringMeetingId})` : ""),
          input.organizerEmployeeId,
          tx
        );
      }

      // Queued with the booking, online or not. For an online meeting the
      // delivery waits for the Teams links (notification.service).
      const queued = await queueBookingNotifications(
        tx,
        insertedMeetings[0].meeting_id,
        input.organizerEmployeeId,
        attendeeIds
      );

      return {
        meetings: insertedMeetings,
        recurringMeetingId,
        notificationId: queued.notificationId,
        invitationNotificationIds: queued.invitationNotificationIds,
        // Side e-mails to organizers who lost their slot (bumped).
        otherNotificationIds: bumpNotificationIds,
      };
    });
  } catch (error) {
    if (error instanceof BookingError) throw error;

    const code = dbErrorCode(error);

    // Backstop: the EXCLUDE constraint caught an overlap the in-transaction
    // check could not see.
    if (code === PG_EXCLUSION_VIOLATION) {
      const conflicts = isSeries
        ? await findConflictingDates(
            db,
            input.roomId,
            input.occurrenceDates,
            startTime,
            endTime
          )
        : undefined;

      throw new BookingError(
        isSeries
          ? "Room is already booked for one or more occurrences"
          : SLOT_TAKEN_MESSAGE,
        409,
        conflicts && conflicts.length > 0 ? conflicts : undefined,
        isSeries ? input.occurrenceDates : undefined
      );
    }

    // deadlock_detected / serialization_failure: nothing was written.
    if (code === "40P01" || code === "40001") {
      throw new BookingError(
        "The booking collided with another request. Please try again.",
        409
      );
    }

    throw error;
  }

  // Preempted meetings may have had a Teams event: remove it (outside the
  // transaction; a failure is retried by the cron sweep).
  if (result.otherNotificationIds.length > 0) dispatchOnlineCleanup();

  const { notificationId, invitationNotificationIds, meetings } = result;
  let online: OnlineBookingOutcome | undefined;

  if (input.online) {
    online = pendingOnlineOutcome(meetings.length);

    // Start on it now rather than at the next minute (background, leased).
    dispatchOnlineProvisioning();
  }

  if (input.notify !== false) {
    dispatchNotification(notificationId!);

    for (const id of result.otherNotificationIds) dispatchNotification(id);
    for (const id of invitationNotificationIds) {
      dispatchNotification(id);
    }
  }

  return {
    ...result,
    meetings,
    notificationId: notificationId!,
    invitationNotificationIds,
    online,
  };
}

// One confirmation e-mail per booking, anchored on the first occurrence (for a
// series, delivery loads the whole series from the database and lists every
// occurrence), plus one invitation per invited participant (anchored on the
// first occurrence; their answer covers a whole series).
async function queueBookingNotifications(
  executor: DbExecutor,
  firstMeetingId: number,
  organizerEmployeeId: number,
  attendeeIds: number[]
) {
  const notificationId = await queueMeetingNotification(
    executor,
    firstMeetingId,
    "BOOKED"
  );

  const invitationNotificationIds: number[] = [];

  for (const employeeId of attendeeIds) {
    if (employeeId === organizerEmployeeId) continue;

    invitationNotificationIds.push(
      await queueMeetingNotification(
        executor,
        firstMeetingId,
        "INVITED",
        employeeId
      )
    );
  }

  return { notificationId, invitationNotificationIds };
}
