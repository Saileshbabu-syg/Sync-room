import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  meeting,
  meeting_attendees,
  recurrence_frequency_master,
  roles,
  recurringMeetingSkippedDates,
  recurring_meetings,
  reschedule_requests,
} from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import type { Tx } from "@/lib/db-types";
import {
  MAX_SERIES_OCCURRENCES,
  computeOccurrenceDates,
  frequencyFromName,
} from "@/lib/recurrence";
import { isMeetingEnded } from "@/lib/time";
import { DATE_REGEX, isValidCalendarDate } from "@/lib/validations/date-time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { BookingError, createBooking } from "./booking.service";
import {
  MeetingEditError,
  applyMeetingEdit,
  editBlocker,
  type MeetingDetailsChange,
} from "./meeting-edit.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";
import { dispatchOnlineCleanup, dispatchOnlineProvisioning } from "./online-meeting.service";
import {
  ROOM_LOCK_NAMESPACE,
  RescheduleError,
  assertMayChange,
  moveLockedMeeting,
  normalizeSlot,
} from "./reschedule.service";

// Lifecycle of recurring series (H-1): editing and cancelling "this occurrence
// only", "this and following" or the "entire series", and changing the
// series' end date (L-2).
//
// Scope semantics (occurrences are rows of `meeting` sharing a
// recurring_meeting_id; they keep that id and their own UID whatever happens):
//  * single     - the chosen occurrence only.
//  * following  - the chosen occurrence and every later one (by date).
//  * series     - every occurrence of the series.
// In every scope only occurrences that still happen are changed: Scheduled
// (or waiting to be rescheduled) and not ended. Completed, cancelled, replaced
// and past occurrences are never touched, so history and reports keep them.
// Each changed occurrence gets its own update or cancellation e-mail (its own
// calendar UID/SEQUENCE: one UID per iTIP message), queued in the same
// transaction and sent after the commit.
//
// Locks, always in this order (the same as booking): room advisory lock(s)
// (only when occurrences move), then the series row, then the occurrence rows
// by id. The series row lock serialises concurrent operations on one series.

export const SERIES_SCOPES = ["single", "following", "series"] as const;

export type SeriesScope = (typeof SERIES_SCOPES)[number];

export class SeriesError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SeriesError";
    this.status = status;
  }
}

// The status and message of an error raised by a lifecycle operation (series,
// move, edit or booking rules), or null for anything unexpected.
export function lifecycleError(error: unknown) {
  if (
    error instanceof SeriesError ||
    error instanceof RescheduleError ||
    error instanceof MeetingEditError ||
    error instanceof BookingError
  ) {
    return { status: error.status, message: error.message };
  }

  return null;
}

type Actor = { employeeId: number; role: string };
type MeetingRow = typeof meeting.$inferSelect;

const stillHappens = (row: MeetingRow, now?: Date) =>
  (row.meetingStatusId === MEETING_STATUS.SCHEDULED ||
    row.meetingStatusId === MEETING_STATUS.PENDING_RESCHEDULE) &&
  !isMeetingEnded(row.meeting_date, row.end_time, now);

// The chosen meeting (unlocked read, to learn its series and rooms).
async function readAnchor(meetingId: number) {
  const [anchor] = await db
    .select()
    .from(meeting)
    .where(eq(meeting.meeting_id, meetingId));

  if (!anchor) throw new SeriesError("Meeting not found.", 404);

  return anchor;
}

// Locks the series row and the rows in scope (by id), re-reading them under
// the lock. Returns the locked anchor and the occurrences the operation may
// change (those that still happen).
async function lockScope(
  tx: Tx,
  anchorId: number,
  recurringMeetingId: number | null,
  scope: SeriesScope,
  now?: Date
) {
  if (scope !== "single" && recurringMeetingId === null) {
    throw new SeriesError("This meeting is not part of a recurring series.", 400);
  }

  if (recurringMeetingId !== null) {
    await tx
      .select({ id: recurring_meetings.recurring_meeting_id })
      .from(recurring_meetings)
      .where(eq(recurring_meetings.recurring_meeting_id, recurringMeetingId))
      .for("update");
  }

  const rows =
    scope === "single"
      ? await tx
          .select()
          .from(meeting)
          .where(eq(meeting.meeting_id, anchorId))
          .orderBy(asc(meeting.meeting_id))
          .for("update")
      : await tx
          .select()
          .from(meeting)
          .where(eq(meeting.recurringMeetingId, recurringMeetingId!))
          .orderBy(asc(meeting.meeting_id))
          .for("update");

  const anchor = rows.find((r) => r.meeting_id === anchorId);

  if (!anchor) throw new SeriesError("Meeting not found.", 404);

  const inScope = rows
    .filter(
      (r) =>
        scope !== "following" ||
        r.meeting_date > anchor.meeting_date ||
        (r.meeting_date === anchor.meeting_date && r.start_time >= anchor.start_time)
    )
    .filter((r) => stillHappens(r, now))
    .sort(
      (a, b) =>
        a.meeting_date.localeCompare(b.meeting_date) ||
        a.start_time.localeCompare(b.start_time)
    );

  return { anchor, targets: inScope };
}

const scopeNote = (scope: SeriesScope, anchor: MeetingRow) =>
  scope === "single"
    ? undefined
    : scope === "following"
      ? `series, this and following from ${anchor.meeting_date}`
      : "entire series";

export type SeriesEditInput = {
  meetingId: number;
  scope: SeriesScope;
  actor: Actor;
  details?: MeetingDetailsChange;
  // A new room and/or time of day for every occurrence in scope (each keeps
  // its own date). Dates of single occurrences move through the reschedule
  // route instead.
  slot?: { roomId?: number; startTime?: string; endTime?: string };
  now?: Date;
  notify?: boolean;
};

// Edits the occurrences in scope. All-or-nothing: if any occurrence cannot
// take the change (a conflict, a policy) nothing is changed. Teams events of
// online occurrences are updated after the commit.
export async function editSeries(input: SeriesEditInput) {
  const anchorRead = await readAnchor(input.meetingId);
  const moving =
    input.slot !== undefined &&
    (input.slot.roomId !== undefined ||
      input.slot.startTime !== undefined ||
      input.slot.endTime !== undefined);

  const result = await db.transaction(async (tx) => {
    // Rooms the moved occurrences will be in, locked first (booking order).
    if (moving) {
      const roomIds =
        input.slot!.roomId !== undefined
          ? [input.slot!.roomId]
          : (
              await tx
                .selectDistinct({ roomId: meeting.room_id })
                .from(meeting)
                .where(
                  anchorRead.recurringMeetingId !== null && input.scope !== "single"
                    ? eq(meeting.recurringMeetingId, anchorRead.recurringMeetingId)
                    : eq(meeting.meeting_id, anchorRead.meeting_id)
                )
            ).map((r) => r.roomId);

      for (const roomId of [...roomIds].sort((a, b) => a - b)) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, ${roomId})`
        );
      }
    }

    const { anchor, targets } = await lockScope(
      tx,
      input.meetingId,
      anchorRead.recurringMeetingId,
      input.scope,
      input.now
    );

    // Only the organizer or an Admin (B-10).
    assertMayChange(anchor, input.actor);

    const blocker = editBlocker(anchor, input.now);

    if (input.scope === "single" && blocker) throw new SeriesError(blocker, 400);

    if (targets.length === 0) {
      throw new SeriesError("No upcoming occurrence is left to change.", 400);
    }

    const note = scopeNote(input.scope, anchor);
    const changed: { meetingId: number; titleOrSlot: boolean }[] = [];
    const invitationIds: number[] = [];

    for (const target of targets) {
      let row = target;
      let moved = false;

      if (moving) {
        const slot = normalizeSlot({
          roomId: input.slot!.roomId ?? row.room_id,
          meetingDate: row.meeting_date,
          startTime: input.slot!.startTime ?? row.start_time,
          endTime: input.slot!.endTime ?? row.end_time,
        });

        const sameSlot =
          slot.roomId === row.room_id &&
          slot.startTime === row.start_time &&
          slot.endTime === row.end_time;

        if (!sameSlot) {
          // Booking window only for the series' first occurrence (B-05):
          // the other dates were accepted with the series.
          await moveLockedMeeting(tx, row, slot, input.actor.employeeId, input.now, false);
          moved = true;

          [row] = await tx.select().from(meeting).where(eq(meeting.meeting_id, row.meeting_id));
        }
      }

      const outcome = input.details
        ? await applyMeetingEdit(tx, row, input.details, input.actor.employeeId, note)
        : null;

      if (outcome) invitationIds.push(...outcome.invitationIds);

      if (moved || outcome) {
        changed.push({
          meetingId: row.meeting_id,
          titleOrSlot: moved || outcome?.titleChanged === true,
        });
      }
    }

    if (changed.length === 0) throw new SeriesError("No changes detected.", 400);

    const updateIds: number[] = [];

    for (const c of changed) {
      updateIds.push(await queueMeetingNotification(tx, c.meetingId, "UPDATED"));
    }

    return { changed, updateIds, invitationIds };
  });

  if (input.notify !== false) {
    for (const id of [...result.updateIds, ...result.invitationIds]) {
      dispatchNotification(id);
    }
  }

  // Teams events follow (same event and link): the changed occurrences were
  // marked for synchronisation in the transaction; the background worker
  // updates them, and a failure there never undoes the edit.
  if (result.changed.some((c) => c.titleOrSlot)) dispatchOnlineProvisioning();

  return {
    changedMeetingIds: result.changed.map((c) => c.meetingId),
    notificationIds: result.updateIds,
  };
}

// Why this meeting cannot be cancelled, or null.
function cancelBlocker(row: MeetingRow, now?: Date) {
  if (row.meetingStatusId === MEETING_STATUS.COMPLETED) {
    return "Completed meetings cannot be cancelled.";
  }

  if (row.meetingStatusId === MEETING_STATUS.CANCELLED) {
    return "Meeting is already cancelled.";
  }

  // Preempted is final and kept as-is in the booking history.
  if (row.meetingStatusId === MEETING_STATUS.PREEMPTED) {
    return "Replaced bookings cannot be cancelled.";
  }

  if (isMeetingEnded(row.meeting_date, row.end_time, now)) {
    return "Meetings that have already ended cannot be cancelled.";
  }

  return null;
}

// Cancels one occurrence, this and the following ones, or the whole series.
// Each cancelled occurrence gets its own cancellation (calendar CANCEL for its
// UID). Teams events are removed after the commit by the existing sweep.
export async function cancelMeetings(input: {
  meetingId: number;
  scope: SeriesScope;
  actor: Actor;
  now?: Date;
  notify?: boolean;
}) {
  const anchorRead = await readAnchor(input.meetingId);

  const notificationIds = await db.transaction(async (tx) => {
    const { anchor, targets } = await lockScope(
      tx,
      input.meetingId,
      anchorRead.recurringMeetingId,
      input.scope,
      input.now
    );

    assertMayChange(anchor, input.actor);

    if (input.scope === "single") {
      const blocker = cancelBlocker(anchor, input.now);

      if (blocker) throw new SeriesError(blocker, 400);
    }

    if (targets.length === 0) {
      throw new SeriesError("No upcoming occurrence is left to cancel.", 400);
    }

    const ids = targets.map((t) => t.meeting_id);
    const note = scopeNote(input.scope, anchor);

    await tx
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.CANCELLED, updated_at: new Date() })
      .where(inArray(meeting.meeting_id, ids));

    // A bumped meeting that its organizer cancels no longer waits for them.
    await tx
      .update(reschedule_requests)
      .set({ status: "CANCELLED", resolved_at: new Date() })
      .where(
        and(
          inArray(reschedule_requests.bumped_meeting_id, ids),
          eq(reschedule_requests.status, "PENDING")
        )
      );

    const queued: number[] = [];

    for (const id of ids) {
      await createAuditLog(
        id,
        AUDIT_ACTION.CANCELLED,
        note ? `Meeting cancelled (${note})` : "Meeting cancelled",
        input.actor.employeeId,
        tx
      );

      queued.push(await queueMeetingNotification(tx, id, "CANCELLED"));
    }

    return queued;
  });

  if (input.notify !== false) {
    for (const id of notificationIds) dispatchNotification(id);
  }

  // The Teams events (if any) are deleted after the commit, never inside it.
  dispatchOnlineCleanup();

  return { cancelledCount: notificationIds.length, notificationIds };
}

type SeriesPattern = {
  recurringMeetingId: number;
  frequencyId: number;
  frequency: NonNullable<ReturnType<typeof frequencyFromName>>;
  interval: number;
  patternStartDate: string;
  untilDate: string | null;
};

async function loadPattern(tx: Tx, recurringMeetingId: number): Promise<SeriesPattern> {
  const [row] = await tx
    .select({
      frequencyId: recurring_meetings.frequency_id,
      frequencyName: recurrence_frequency_master.frequency_name,
      interval: recurring_meetings.recurrence_interval,
      patternStartDate: recurring_meetings.pattern_start_date,
      untilDate: recurring_meetings.until_date,
    })
    .from(recurring_meetings)
    .innerJoin(
      recurrence_frequency_master,
      eq(recurrence_frequency_master.frequency_id, recurring_meetings.frequency_id)
    )
    .where(eq(recurring_meetings.recurring_meeting_id, recurringMeetingId));

  if (!row) throw new SeriesError("Series not found.", 404);

  const frequency = frequencyFromName(row.frequencyName);

  if (!frequency) {
    throw new SeriesError("This series uses a recurrence frequency that is not supported.", 400);
  }

  let patternStartDate = row.patternStartDate;

  // Series stored before the pattern was: their first booked date.
  if (!patternStartDate) {
    const [first] = await tx
      .select({ date: sql<string>`min(${meeting.meeting_date})` })
      .from(meeting)
      .where(eq(meeting.recurringMeetingId, recurringMeetingId));

    patternStartDate = first.date;
  }

  return {
    recurringMeetingId,
    frequencyId: row.frequencyId,
    frequency,
    interval: row.interval,
    patternStartDate,
    untilDate: row.untilDate,
  };
}

export async function skippedDatesOf(executor: Tx | typeof db, recurringMeetingId: number) {
  const rows = await executor
    .select({ date: recurringMeetingSkippedDates.skippedDate })
    .from(recurringMeetingSkippedDates)
    .where(eq(recurringMeetingSkippedDates.recurringMeetingId, recurringMeetingId))
    .orderBy(asc(recurringMeetingSkippedDates.skippedDate));

  return rows.map((r) => r.date);
}

// The series a meeting belongs to: its pattern, skipped dates and occurrences.
export async function getSeriesDetails(meetingId: number, actor: Actor) {
  const anchor = await readAnchor(meetingId);

  if (anchor.recurringMeetingId === null) {
    throw new SeriesError("This meeting is not part of a recurring series.", 404);
  }

  const isParticipant =
    (
      await db
        .select({ id: meeting_attendees.employee_id })
        .from(meeting_attendees)
        .where(
          and(
            eq(meeting_attendees.meeting_id, meetingId),
            eq(meeting_attendees.employee_id, actor.employeeId)
          )
        )
    ).length > 0;

  try {
    assertMayChange(anchor, actor);
  } catch {
    if (!isParticipant) {
      throw new SeriesError("You do not have permission to view this series.", 403);
    }
  }

  return db.transaction(async (tx) => {
    const pattern = await loadPattern(tx, anchor.recurringMeetingId!);

    const occurrences = await tx
      .select({
        meetingId: meeting.meeting_id,
        date: meeting.meeting_date,
        startTime: meeting.start_time,
        endTime: meeting.end_time,
        roomId: meeting.room_id,
        statusId: meeting.meetingStatusId,
      })
      .from(meeting)
      .where(eq(meeting.recurringMeetingId, pattern.recurringMeetingId))
      .orderBy(asc(meeting.meeting_date), asc(meeting.start_time));

    return {
      recurringMeetingId: pattern.recurringMeetingId,
      frequency: pattern.frequency,
      interval: pattern.interval,
      patternStartDate: pattern.patternStartDate,
      untilDate: pattern.untilDate,
      skippedDates: await skippedDatesOf(tx, pattern.recurringMeetingId),
      occurrences,
    };
  });
}

// Changes when the series ends (L-2), counted on its stored pattern:
//  * shorter: upcoming occurrences after the new end date are cancelled (each
//    with its cancellation); past and historical ones are untouched;
//  * longer: the pattern's dates after the last occurrence, up to the new end
//    date, are booked (same title, room, times, type and attendees as the
//    latest upcoming occurrence; attendees keep the answer they gave for the
//    series), through the normal booking checks, all-or-nothing;
//  * skipped dates are never booked; they are kept even when they now fall
//    after the end date, so extending again later still leaves them out.
// The pattern itself (frequency, interval, start date) cannot be changed: to
// change it, end the series and book a new one.
export async function changeSeriesEnd(input: {
  meetingId: number;
  endDate: string;
  actor: Actor;
  now?: Date;
  notify?: boolean;
}) {
  if (!DATE_REGEX.test(input.endDate) || !isValidCalendarDate(input.endDate)) {
    throw new SeriesError("end_date must be a valid YYYY-MM-DD date.", 400);
  }

  const anchorRead = await readAnchor(input.meetingId);

  if (anchorRead.recurringMeetingId === null) {
    throw new SeriesError("This meeting is not part of a recurring series.", 400);
  }

  const seriesId = anchorRead.recurringMeetingId;

  // Shortening (and recording the new end) under the series lock.
  const plan = await db.transaction(async (tx) => {
    const { anchor, targets } = await lockScope(tx, input.meetingId, seriesId, "series", input.now);

    assertMayChange(anchor, input.actor);

    const pattern = await loadPattern(tx, seriesId);

    if (input.endDate < pattern.patternStartDate) {
      throw new SeriesError("The end date cannot be before the start of the series.", 400);
    }

    const all = await tx
      .select()
      .from(meeting)
      .where(eq(meeting.recurringMeetingId, seriesId));

    // One more than allowed, so a too-long series is refused, never cut.
    const grid = computeOccurrenceDates(
      pattern.patternStartDate,
      pattern.frequency,
      MAX_SERIES_OCCURRENCES + 1,
      { interval: pattern.interval, until: input.endDate }
    );

    if (grid.length > MAX_SERIES_OCCURRENCES) {
      throw new SeriesError(
        `That end date gives more than ${MAX_SERIES_OCCURRENCES} occurrences. Choose an earlier end date.`,
        400
      );
    }

    const skipped = new Set(await skippedDatesOf(tx, seriesId));
    const existingDates = new Set(all.map((m) => m.meeting_date));
    const lastExisting = [...existingDates].sort().at(-1) ?? pattern.patternStartDate;

    const toCancel = targets.filter((t) => t.meeting_date > input.endDate);
    const toAdd = grid.filter(
      (d) => d > lastExisting && !existingDates.has(d) && !skipped.has(d)
    );

    const cancelIds: number[] = [];

    if (toCancel.length > 0) {
      await tx
        .update(meeting)
        .set({ meetingStatusId: MEETING_STATUS.CANCELLED, updated_at: new Date() })
        .where(inArray(meeting.meeting_id, toCancel.map((t) => t.meeting_id)));

      for (const t of toCancel) {
        await createAuditLog(
          t.meeting_id,
          AUDIT_ACTION.CANCELLED,
          `Meeting cancelled (series now ends ${input.endDate})`,
          input.actor.employeeId,
          tx
        );
        cancelIds.push(await queueMeetingNotification(tx, t.meeting_id, "CANCELLED"));
      }
    }

    await tx
      .update(recurring_meetings)
      .set({ until_date: input.endDate, updated_at: new Date() })
      .where(eq(recurring_meetings.recurring_meeting_id, seriesId));

    // The newest upcoming occurrence is the template for added dates.
    const template = [...targets]
      .filter((t) => t.meeting_date <= input.endDate)
      .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date))
      .at(-1);

    return { pattern, cancelIds, toAdd, template, gridSize: grid.length };
  });

  if (input.notify !== false) {
    for (const id of plan.cancelIds) dispatchNotification(id);
  }

  if (plan.cancelIds.length > 0) dispatchOnlineCleanup();

  let added: number[] = [];

  if (plan.toAdd.length > 0) {
    if (!plan.template) {
      throw new SeriesError(
        "The series has no upcoming occurrence to copy for the new dates. Book a new series instead.",
        400
      );
    }

    const template = plan.template;

    // The booking stays the organizer's (an Admin may be the one extending).
    const [owner] = await db
      .select({ role: roles.roleName })
      .from(employee)
      .innerJoin(roles, eq(roles.roleId, employee.role_id))
      .where(eq(employee.employee_id, template.organizerEmployeeId));

    const attendees = await db
      .select()
      .from(meeting_attendees)
      .where(eq(meeting_attendees.meeting_id, template.meeting_id));

    try {
      const result = await createBooking({
        title: template.title,
        roomId: template.room_id,
        occurrenceDates: plan.toAdd,
        startTime: template.start_time,
        endTime: template.end_time,
        organizerEmployeeId: template.organizerEmployeeId,
        organizerRole: owner?.role ?? "",
        participantCount: template.participantCount,
        meetingTypeId: template.meetingTypeId,
        participantEmployeeIds: attendees
          .filter((a) => !a.is_optional && a.employee_id !== template.organizerEmployeeId)
          .map((a) => a.employee_id),
        optionalParticipantEmployeeIds: attendees
          .filter((a) => a.is_optional)
          .map((a) => a.employee_id),
        requestedOccurrences: plan.gridSize,
        recurrence: {
          frequencyId: plan.pattern.frequencyId,
          occurrenceCount: plan.toAdd.length,
          appendToSeriesId: seriesId,
        },
        online: template.online_requested,
        // The new occurrences join the series with the same answers.
        inTransaction: async (tx, meetings) => {
          await tx
            .select({ id: recurring_meetings.recurring_meeting_id })
            .from(recurring_meetings)
            .where(eq(recurring_meetings.recurring_meeting_id, seriesId))
            .for("update");

          for (const a of attendees) {
            await tx
              .update(meeting_attendees)
              .set({ response_status: a.response_status })
              .where(
                and(
                  inArray(meeting_attendees.meeting_id, meetings.map((m) => m.meeting_id)),
                  eq(meeting_attendees.employee_id, a.employee_id)
                )
              );
          }

          await tx
            .update(recurring_meetings)
            .set({
              occurrence_count: sql`${recurring_meetings.occurrence_count} + ${meetings.length}`,
              recurrence_end_date: plan.toAdd.at(-1)!,
              updated_at: new Date(),
            })
            .where(eq(recurring_meetings.recurring_meeting_id, seriesId));
        },
        now: input.now,
        notify: input.notify,
      });

      added = result.meetings.map((m) => m.meeting_id);
    } catch (error) {
      if (error instanceof BookingError) throw new SeriesError(error.message, error.status);

      throw error;
    }
  }

  return { cancelledCount: plan.cancelIds.length, addedMeetingIds: added };
}
