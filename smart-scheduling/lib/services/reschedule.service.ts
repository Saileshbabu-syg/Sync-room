import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  meeting,
  reminder_logs,
  reschedule_requests,
  room,
} from "@/db/schema";
import {
  APP_TIMEZONE,
  AVAILABILITY_STATUS,
  MEETING_STATUS,
  REMINDER_LEAD_MINUTES,
  ROLE_ADMIN,
} from "@/lib/constants";
import { isSlotStartInPast, normalizeTime, timeToSeconds } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { findConflictingDates } from "./conflict-check.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";

// Lets the organizer of a bumped meeting (status PENDING_RESCHEDULE) move it to
// a free room, date and time before it is cancelled automatically. The new slot
// must be free: a reschedule never bumps anyone. On success the meeting is
// Scheduled again, the pending reschedule request is closed and every attendee
// is told about the change.

const ROOM_LOCK_NAMESPACE = 7001;

export class RescheduleError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RescheduleError";
    this.status = status;
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

export async function rescheduleMeeting(input: RescheduleInput) {
  let startTime: string;
  let endTime: string;

  try {
    startTime = normalizeTime(input.startTime);
    endTime = normalizeTime(input.endTime);
  } catch {
    throw new RescheduleError("Invalid start or end time", 400);
  }

  if (timeToSeconds(startTime) >= timeToSeconds(endTime)) {
    throw new RescheduleError("End time must be after start time", 400);
  }

  if (isSlotStartInPast(input.meetingDate, startTime, input.now)) {
    throw new RescheduleError("Meetings cannot be moved to the past", 400);
  }

  const notificationId = await db.transaction(async (tx) => {
    // Same lock order as booking (room first), then the meeting row.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, ${input.roomId})`
    );

    const [existing] = await tx
      .select()
      .from(meeting)
      .where(eq(meeting.meeting_id, input.meetingId))
      .for("update");

    if (!existing) throw new RescheduleError("Meeting not found.", 404);

    if (
      existing.organizerEmployeeId !== input.actor.employeeId &&
      input.actor.role !== ROLE_ADMIN
    ) {
      throw new RescheduleError(
        "You do not have permission to change this meeting.",
        403
      );
    }

    if (existing.meetingStatusId !== MEETING_STATUS.PENDING_RESCHEDULE) {
      throw new RescheduleError(
        "Only a meeting waiting to be rescheduled can be moved.",
        400
      );
    }

    const [roomDetails] = await tx
      .select()
      .from(room)
      .where(eq(room.room_id, input.roomId))
      .for("share");

    if (!roomDetails) throw new RescheduleError("Room not found.", 404);

    if (roomDetails.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE) {
      throw new RescheduleError(
        "This room is currently unavailable for booking.",
        409
      );
    }

    // The meeting itself no longer holds a slot, so it cannot conflict with
    // itself.
    const conflicts = await findConflictingDates(
      tx,
      input.roomId,
      [input.meetingDate],
      startTime,
      endTime
    );

    if (conflicts.length > 0) {
      throw new RescheduleError(
        "Room is already booked for the selected time slot",
        409
      );
    }

    await tx
      .update(meeting)
      .set({
        room_id: input.roomId,
        meeting_date: input.meetingDate,
        start_time: startTime,
        end_time: endTime,
        meetingStatusId: MEETING_STATUS.SCHEDULED,
        updated_at: new Date(),
      })
      .where(eq(meeting.meeting_id, input.meetingId));

    await tx
      .update(reschedule_requests)
      .set({ status: "RESCHEDULED", resolved_at: new Date() })
      .where(
        and(
          eq(reschedule_requests.bumped_meeting_id, input.meetingId),
          eq(reschedule_requests.status, "PENDING")
        )
      );

    // The reminder follows the new start time (and is re-armed).
    await tx
      .update(reminder_logs)
      .set({
        status: "PENDING",
        attempts: 0,
        reminder_time: sql`GREATEST(
          ((${input.meetingDate}::date + ${startTime}::time) AT TIME ZONE ${APP_TIMEZONE}::text)
            - make_interval(mins => ${REMINDER_LEAD_MINUTES}),
          now()
        )`,
      })
      .where(eq(reminder_logs.meeting_id, input.meetingId));

    await createAuditLog(
      input.meetingId,
      AUDIT_ACTION.RESCHEDULED,
      `Rescheduled to ${roomDetails.room_name} on ${input.meetingDate} ${startTime}-${endTime}`,
      input.actor.employeeId,
      tx
    );

    return queueMeetingNotification(tx, input.meetingId, "UPDATED");
  });

  if (input.notify !== false) dispatchNotification(notificationId);

  return { notificationId };
}
