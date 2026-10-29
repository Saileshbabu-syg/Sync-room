import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
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
import { isSlotStartInPast, normalizeTime, timeToSeconds } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { findConflictingDates } from "./conflict-check.service";
import { isMeetingTypeAllowedForRole } from "./meeting-type-access.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";
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
        .select({ id: meetingTypes.meetingTypeId })
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

      if (conflictingDates.length > 0) {
        throw new BookingError(
          isSeries
            ? "Room is already booked for one or more occurrences"
            : "Room is already booked for the selected time slot",
          409,
          isSeries ? conflictingDates : undefined,
          isSeries ? input.occurrenceDates : undefined
        );
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

      await tx.insert(meeting_attendees).values(
        insertedMeetings.flatMap((m) =>
          attendeeIds.map((employeeId) => ({
            meeting_id: m.meeting_id,
            employee_id: employeeId,
          }))
        )
      );

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

      // One confirmation e-mail per booking (for a series: for its first
      // occurrence, as before).
      const notificationId = await queueMeetingNotification(
        tx,
        insertedMeetings[0].meeting_id,
        "BOOKED"
      );

      return { meetings: insertedMeetings, recurringMeetingId, notificationId };
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
          : "Room is already booked for the selected time slot",
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
  }

  return result;
}
