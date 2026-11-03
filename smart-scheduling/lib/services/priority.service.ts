import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  groups,
  meeting,
  reschedule_requests,
  room,
} from "@/db/schema";
import {
  AVAILABILITY_STATUS,
  BUMP_RESPONSE_CUTOFF_MINUTES,
  FALLBACK_PRIORITY,
  MEETING_STATUS,
} from "@/lib/constants";
import type { DbExecutor, Tx } from "@/lib/db-types";
import { appWallClockToUtc, isSlotStartInPast } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { holdsSlot, overlapsSlot } from "./conflict-check.service";
import {
  getPriorityContext,
  type PriorityContext,
} from "./group-context.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";

// Group-based booking priority.
//
// Every booking stores a snapshot of its organizer's group and priority at the
// moment it was made (meeting.group_id_at_booking / priority_at_booking).
// Priority 1 is the highest. When a booking asks for a slot that is held by
// confirmed meetings:
//
//  * every overlapping meeting (partial overlaps included) is found and locked
//    before anything is changed;
//  * the booking may proceed only if its organizer's group may preempt
//    (booking.priority) AND every holder has a STRICTLY lower priority (a
//    larger number) AND none has started. Equal priority is
//    first-confirmed-wins; a lower group never preempts a higher one;
//  * each holder is set to PREEMPTED in the same transaction that inserts the
//    new booking, with an append-only booking_priority_history row, an audit
//    log entry and an e-mail to the preempted meeting's attendees.
//
// Holders are compared on their STORED snapshot, so later group or priority
// edits never rewrite the past. Meetings that pre-date groups have no snapshot
// and rank as the default policy (the lowest active group).
//
// PREEMPTED is final. Meetings already waiting in PENDING_RESCHEDULE from the
// earlier meeting-type engine still use the reschedule flow below until they
// are resolved.

// SQL: a booked meeting's priority (its snapshot, or the default policy).
export const bookedPriority = sql<number>`coalesce(
  ${meeting.priorityAtBooking},
  (select coalesce(max(${groups.priority}), ${FALLBACK_PRIORITY}::int) from ${groups} where ${groups.isActive})
)::int`;

export type SlotHolder = {
  meetingId: number;
  title: string;
  roomId: number;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
  organizerEmployeeId: number;
  groupId: number | null;
  // Snapshot priority (default policy for legacy meetings).
  priority: number;
};

// Meetings that hold part of the requested slot, locked for the rest of the
// transaction so two bookings cannot preempt the same meeting.
export async function findSlotHolders(
  executor: DbExecutor,
  roomId: number,
  meetingDates: string[],
  startTime: string,
  endTime: string
): Promise<SlotHolder[]> {
  if (meetingDates.length === 0) return [];

  return executor
    .select({
      meetingId: meeting.meeting_id,
      title: meeting.title,
      roomId: meeting.room_id,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      participantCount: meeting.participantCount,
      organizerEmployeeId: meeting.organizerEmployeeId,
      groupId: meeting.groupIdAtBooking,
      priority: bookedPriority,
    })
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        inArray(meeting.meeting_date, meetingDates),
        holdsSlot,
        overlapsSlot(startTime, endTime)
      )
    )
    .orderBy(asc(meeting.meeting_date), asc(meeting.start_time))
    .for("update", { of: meeting });
}

// True when the claimant may take the slot from EVERY holder.
export function canBumpAll(
  holders: SlotHolder[],
  claimant: Pick<PriorityContext, "priority" | "canPreempt">,
  now?: Date
) {
  if (holders.length === 0) return true;

  return (
    claimant.canPreempt &&
    holders.every(
      (h) =>
        h.priority > claimant.priority &&
        !isSlotStartInPast(h.meetingDate, h.startTime, now)
    )
  );
}

export type ReleasedSlot = {
  holder: SlotHolder;
};

// The moment a legacy pending bumped meeting is cancelled if nothing was
// changed: BUMP_RESPONSE_CUTOFF_MINUTES before it starts.
export function bumpDeadline(meetingDate: string, startTime: string) {
  const [y, mo, d, h, mi] = appWallClockToUtc(meetingDate, startTime);

  return new Date(
    Date.UTC(y, mo - 1, d, h, mi) - BUMP_RESPONSE_CUTOFF_MINUTES * 60_000
  );
}

// Sets every holder to PREEMPTED. Call before inserting the claiming meeting,
// so the room-overlap constraint is satisfied.
export async function releaseSlots(
  tx: Tx,
  holders: SlotHolder[]
): Promise<ReleasedSlot[]> {
  for (const holder of holders) {
    await tx
      .update(meeting)
      .set({
        meetingStatusId: MEETING_STATUS.PREEMPTED,
        updated_at: new Date(),
      })
      .where(eq(meeting.meeting_id, holder.meetingId));
  }

  return holders.map((holder) => ({ holder }));
}

// Records each preemption (append-only history + audit log) against the
// meeting that took the slot and queues the e-mail to the preempted meeting's
// attendees. Returns the notification ids to dispatch after commit.
export async function recordBumps(
  tx: Tx,
  released: ReleasedSlot[],
  claimants: { meetingId: number; meetingDate: string }[],
  incoming: {
    actorEmployeeId: number;
    groupId: number | null;
    groupName: string | null;
    priority: number;
  }
): Promise<number[]> {
  const notificationIds: number[] = [];

  for (const { holder } of released) {
    const claimant = claimants.find(
      (c) => c.meetingDate === holder.meetingDate
    );

    // Every released slot belongs to one of the requested dates.
    if (!claimant) continue;

    const reason = `Preempted by ${incoming.groupName ?? "default-policy"} booking #${claimant.meetingId}: priority ${incoming.priority} outranks ${holder.priority}`;

    await tx.insert(bookingPriorityHistory).values({
      incomingBookingId: claimant.meetingId,
      affectedBookingId: holder.meetingId,
      previousGroupId: holder.groupId,
      previousPriority: holder.priority,
      incomingGroupId: incoming.groupId,
      incomingPriority: incoming.priority,
      reason,
      actorEmployeeId: incoming.actorEmployeeId,
    });

    await createAuditLog(
      holder.meetingId,
      AUDIT_ACTION.PREEMPTED,
      reason,
      incoming.actorEmployeeId,
      tx
    );

    notificationIds.push(
      await queueMeetingNotification(tx, holder.meetingId, "PREEMPTED")
    );
  }

  return notificationIds;
}

// Legacy: cancels every pending bumped meeting (from the earlier engine) whose
// organizer did not change it in time and e-mails its attendees. Run by the
// cron tick; rows are claimed with SKIP LOCKED so several instances never
// cancel (or mail) the same meeting twice.
export async function processExpiredBumps(now: Date = new Date()) {
  const notificationIds: number[] = [];

  await db.transaction(async (tx) => {
    const due = await tx
      .select({
        requestId: reschedule_requests.reschedule_request_id,
        meetingId: reschedule_requests.bumped_meeting_id,
      })
      .from(reschedule_requests)
      .innerJoin(
        meeting,
        eq(meeting.meeting_id, reschedule_requests.bumped_meeting_id)
      )
      .where(
        and(
          eq(reschedule_requests.status, "PENDING"),
          lte(reschedule_requests.deadline, now),
          eq(meeting.meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE)
        )
      )
      .for("update", { of: [reschedule_requests, meeting], skipLocked: true });

    for (const { requestId, meetingId } of due) {
      await tx
        .update(meeting)
        .set({
          meetingStatusId: MEETING_STATUS.CANCELLED,
          updated_at: new Date(),
        })
        .where(eq(meeting.meeting_id, meetingId));

      await tx
        .update(reschedule_requests)
        .set({ status: "AUTO_CANCELLED", resolved_at: new Date() })
        .where(eq(reschedule_requests.reschedule_request_id, requestId));

      await createAuditLog(
        meetingId,
        AUDIT_ACTION.BUMPED_CANCELLED,
        "Cancelled automatically: the room or time was not changed before the deadline",
        null,
        tx
      );

      notificationIds.push(
        await queueMeetingNotification(tx, meetingId, "BUMPED")
      );
    }
  });

  for (const id of notificationIds) dispatchNotification(id);

  return notificationIds.length;
}

// Rooms that look busy for the slot but that this employee's group could take:
// every confirmed meeting in them has a strictly lower priority and has not
// started. Used only to show those rooms in the picker - the booking itself
// re-checks everything under lock.
export async function getClaimableRooms(
  employeeId: number,
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number,
  now?: Date
) {
  const claimant = await getPriorityContext(employeeId);

  if (!claimant.canPreempt) return [];

  const holders = await db
    .select({
      roomId: meeting.room_id,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      priority: bookedPriority,
    })
    .from(meeting)
    .where(
      and(
        eq(meeting.meeting_date, meetingDate),
        holdsSlot,
        overlapsSlot(startTime, endTime)
      )
    );

  const byRoom = new Map<number, typeof holders>();

  for (const h of holders) {
    byRoom.set(h.roomId, [...(byRoom.get(h.roomId) ?? []), h]);
  }

  const claimableIds = [...byRoom.entries()]
    .filter(([, list]) =>
      list.every(
        (h) =>
          h.priority > claimant.priority &&
          !isSlotStartInPast(h.meetingDate, h.startTime, now)
      )
    )
    .map(([roomId]) => roomId);

  if (claimableIds.length === 0) return [];

  return db
    .select()
    .from(room)
    .where(
      and(
        inArray(room.room_id, claimableIds),
        eq(room.availabilityStatusId, AVAILABILITY_STATUS.AVAILABLE)
      )
    );
}
