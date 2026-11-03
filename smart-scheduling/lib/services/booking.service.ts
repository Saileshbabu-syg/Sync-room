import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  type Meeting,
  meeting,
  meeting_attendees,
  meetingTypes,
  recurrence_frequency_master,
  recurring_meetings,
  room,
} from "@/db/schema";
import {
  AVAILABILITY_STATUS,
  MEETING_STATUS,
} from "@/lib/constants";
import { dbErrorCode, PG_EXCLUSION_VIOLATION } from "@/lib/api";
import type { Tx } from "@/lib/db-types";
import { effectiveRank } from "@/lib/priority-rank";
import { isSlotStartInPast, normalizeTime, timeToSeconds } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { findConflictingDates } from "./conflict-check.service";
import { isMeetingTypeAllowedForRole } from "./meeting-type-access.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";
import {
  cancelYielded,
  canBumpAll,
  findSlotHolders,
  maxPriorityBoost,
  recordBumps,
  releaseSlots,
  type ReleasedSlot,
} from "./priority.service";
import { createRemindersForMeetings } from "./reminder.service";

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
//  * Priority: a slot held only by meetings of strictly lower priority (see
//    priority.service) is taken over instead of rejected - those meetings are
//    put on hold (PENDING_RESCHEDULE) for their organizers to move, and
//    cancelled automatically if they do not; their attendees are e-mailed.
//    Rank = meeting type rank adjusted by the roles of organizer and attendees.

// The message for "this single slot is taken"; the booking route recognises it
// to offer a room request instead of a bare error.
export const SLOT_TAKEN_MESSAGE = "Room is already booked for the selected time slot";

export class BookingError extends Error {
  status: number;
  conflicts?: string[];
  // Every date the series would have used, so the caller can show which
  // occurrences are free and which are taken.
  occurrenceDates?: string[];

  constructor(
    message: string,
    status: number,
    conflicts?: string[],
    occurrenceDates?: string[]
  ) {
    super(message);
    this.name = "BookingError";
    this.status = status;
    this.conflicts = conflicts;
    this.occurrenceDates = occurrenceDates;
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
  recurrence?: { frequencyId: number; occurrenceCount: number };
  // Meetings whose organizer has agreed to give the slot up (an approved room
  // request): they are cancelled whatever their priority.
  yieldMeetingIds?: number[];
  // Never take a slot from another meeting, whatever the priority (used when a
  // request is completed for an approved room request).
  noBump?: boolean;
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

  if (timeToSeconds(startTime) >= timeToSeconds(endTime)) {
    throw new BookingError("End time must be after start time", 400);
  }

  if (input.occurrenceDates.length === 0) {
    throw new BookingError("At least one meeting date is required", 400);
  }

  if (isSlotStartInPast(input.occurrenceDates[0], startTime, input.now)) {
    throw new BookingError("Meetings cannot be booked in the past", 400);
  }

  const requestedAttendees = input.participantEmployeeIds ?? [];
  const maximumAttendees = input.participantCount - 1;

  // Organizer is counted as one participant, so attendees can only be
  // participant_count - 1.
  if (requestedAttendees.length > maximumAttendees) {
    throw new BookingError(
      `You can add only ${maximumAttendees} attendee(s). The organizer is counted automatically.`,
      400
    );
  }

  const attendeeIds = [
    ...new Set([input.organizerEmployeeId, ...requestedAttendees]),
  ];

  let result;

  try {
    result = await db.transaction(async (tx) => {
      // Serialise bookings of the same room; other rooms proceed in parallel.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, ${input.roomId})`
      );

      const [roomDetails] = await tx
        .select()
        .from(room)
        .where(eq(room.room_id, input.roomId))
        .for("share");

      if (!roomDetails) {
        throw new BookingError("Room not found", 404);
      }

      // Current status, read under lock — not whatever the page showed earlier.
      if (roomDetails.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE) {
        throw new BookingError(
          "This room is currently unavailable for booking.",
          409
        );
      }

      if (input.participantCount > roomDetails.room_capacity) {
        throw new BookingError(
          `Room capacity exceeded. Room capacity is ${roomDetails.room_capacity}.`,
          400
        );
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

      if (
        !(await isMeetingTypeAllowedForRole(
          input.organizerRole,
          input.meetingTypeId,
          tx
        ))
      ) {
        throw new BookingError(
          "Your role is not allowed to book this meeting type.",
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
      let yieldedNotificationIds: number[] = [];

      if (conflictingDates.length > 0) {
        // The booking's rank counts the roles of everyone in it (organizer
        // included), so a manager in the meeting lifts it.
        const claimantRank = effectiveRank(
          meetingTypeRow.priorityRank,
          await maxPriorityBoost(tx, attendeeIds)
        );

        const holders = await findSlotHolders(
          tx,
          input.roomId,
          input.occurrenceDates,
          startTime,
          endTime
        );

        const yielded = new Set(input.yieldMeetingIds ?? []);
        const yieldedHolders = holders.filter((h) => yielded.has(h.meetingId));
        const others = holders.filter((h) => !yielded.has(h.meetingId));

        // Only a booking that outranks EVERY other meeting in the way may
        // proceed; meetings whose organizer agreed to leave need no rank.
        if (
          (input.noBump && others.length > 0) ||
          !canBumpAll(others, claimantRank, input.now)
        ) {
          throw new BookingError(
            isSeries
              ? "Room is already booked for one or more occurrences"
              : SLOT_TAKEN_MESSAGE,
            409,
            isSeries ? conflictingDates : undefined,
            isSeries ? input.occurrenceDates : undefined
          );
        }

        yieldedNotificationIds = await cancelYielded(
          tx,
          yieldedHolders,
          input.organizerEmployeeId
        );
        released = await releaseSlots(tx, others, input.now);
      }

      let recurringMeetingId: number | null = null;

      if (input.recurrence) {
        const [series] = await tx
          .insert(recurring_meetings)
          .values({
            frequency_id: input.recurrence.frequencyId,
            occurrence_count: input.recurrence.occurrenceCount,
            recurrence_end_date:
              input.occurrenceDates[input.occurrenceDates.length - 1],
          })
          .returning();

        recurringMeetingId = series.recurring_meeting_id;
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
        input.organizerEmployeeId
      );

      await tx.insert(meeting_attendees).values(
        insertedMeetings.flatMap((m) =>
          attendeeIds.map((employeeId) => ({
            meeting_id: m.meeting_id,
            employee_id: employeeId,
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

      // One confirmation e-mail per booking. It is anchored on the first
      // occurrence; for a series, delivery loads the whole series from the
      // database and lists every occurrence.
      const notificationId = await queueMeetingNotification(
        tx,
        insertedMeetings[0].meeting_id,
        "BOOKED"
      );

      return {
        meetings: insertedMeetings,
        recurringMeetingId,
        notificationId,
        // Side e-mails to organizers who lost their slot (bumped or yielded).
        otherNotificationIds: [
          ...bumpNotificationIds,
          ...yieldedNotificationIds,
        ],
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

  if (input.notify !== false) {
    dispatchNotification(result.notificationId);

    for (const id of result.otherNotificationIds) dispatchNotification(id);
  }

  return result;
}
