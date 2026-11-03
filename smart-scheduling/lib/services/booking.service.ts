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
  PERMISSION,
} from "@/lib/constants";
import { dbErrorCode, PG_EXCLUSION_VIOLATION } from "@/lib/api";
import type { Tx } from "@/lib/db-types";
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
import { checkBookingPolicy, getBookingPolicy } from "./booking-policy.service";
import {
  canBumpAll,
  findSlotHolders,
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
//  * Priority: the organizer's CURRENT group and permissions are read from the
//    database under the room lock (never from the client). A slot held only by
//    confirmed, not-yet-started meetings of strictly lower group priority (see
//    priority.service) is taken over instead of rejected: those meetings become
//    PREEMPTED in the same transaction, with history rows, and their attendees
//    are e-mailed. The group and priority used are stored on the new meetings.

// The message for "this single slot is taken".
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
  // Invited, but not essential: they get the same invitation (marked optional)
  // and their answer never affects the booking.
  optionalParticipantEmployeeIds?: number[];
  recurrence?: { frequencyId: number; occurrenceCount: number };
  // How many occurrences the user asked for (some may be skipped later), for
  // the group's series-length limit.
  requestedOccurrences?: number;
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

  const requestedAttendees = [...new Set(input.participantEmployeeIds ?? [])];
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
      const policyProblem = checkBookingPolicy(
        await getBookingPolicy(input.organizerEmployeeId, tx, claimant),
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

      const [meetingTypeRow] = await tx
        .select({
          id: meetingTypes.meetingTypeId,
        })
        .from(meetingTypes)
        .where(eq(meetingTypes.meetingTypeId, input.meetingTypeId));

      if (!meetingTypeRow) {
        throw new BookingError("Meeting type not found", 404);
      }

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

        // Only a booking that outranks EVERY other meeting in the way may
        // proceed.
        if (!canBumpAll(holders, claimant, input.now)) {
          throw new BookingError(
            isSeries
              ? "Room is already booked for one or more occurrences"
              : SLOT_TAKEN_MESSAGE,
            409,
            isSeries ? conflictingDates : undefined,
            isSeries ? input.occurrenceDates : undefined
          );
        }

        released = await releaseSlots(tx, holders);
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
            // Snapshot of the standing used for this booking; later group or
            // priority changes never rewrite it.
            groupIdAtBooking: claimant.groupId,
            priorityAtBooking: claimant.priority,
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
          priority: claimant.priority,
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

      // One confirmation e-mail per booking. It is anchored on the first
      // occurrence; for a series, delivery loads the whole series from the
      // database and lists every occurrence.
      const notificationId = await queueMeetingNotification(
        tx,
        insertedMeetings[0].meeting_id,
        "BOOKED"
      );

      // One invitation per invited participant (anchored on the first
      // occurrence; their answer covers a whole series).
      const invitationNotificationIds: number[] = [];

      for (const employeeId of attendeeIds) {
        if (employeeId === input.organizerEmployeeId) continue;

        invitationNotificationIds.push(
          await queueMeetingNotification(
            tx,
            insertedMeetings[0].meeting_id,
            "INVITED",
            employeeId
          )
        );
      }

      return {
        meetings: insertedMeetings,
        recurringMeetingId,
        notificationId,
        invitationNotificationIds,
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

  if (input.notify !== false) {
    dispatchNotification(result.notificationId);

    for (const id of result.otherNotificationIds) dispatchNotification(id);
    for (const id of result.invitationNotificationIds) {
      dispatchNotification(id);
    }
  }

  return result;
}
