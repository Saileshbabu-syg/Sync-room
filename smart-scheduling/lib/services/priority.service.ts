import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  meeting,
  meeting_attendees,
  meetingTypes,
  reschedule_requests,
  roles,
  room,
} from "@/db/schema";
import {
  AVAILABILITY_STATUS,
  BUMP_RESPONSE_CUTOFF_MINUTES,
  MEETING_STATUS,
} from "@/lib/constants";
import type { DbExecutor, Tx } from "@/lib/db-types";
import { RANK_SPAN } from "@/lib/priority-rank";
import { appWallClockToUtc, isSlotStartInPast } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { holdsSlot, overlapsSlot } from "./conflict-check.service";
import { getAllowedMeetingTypes } from "./meeting-type-access.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";

// Priority-based scheduling.
//
// Every meeting type has a `priority_rank` (1 = highest ... 5 = lowest). When a
// booking asks for a slot that is held by meetings of strictly LOWER priority,
// those meetings are bumped instead of the booking being rejected:
//
//  * the higher-priority booking takes the room straight away;
//  * the bumped meeting becomes PENDING_RESCHEDULE: it no longer holds the slot
//    and only its organizer is e-mailed (meeting type and organizer of the
//    booking that needed the room). They can move it to another room or time
//    (reschedule.service, which mails every attendee); if they have not by
//    BUMP_RESPONSE_CUTOFF_MINUTES before it starts, processExpiredBumps cancels
//    it and mails every attendee;
//  * a meeting that starts within that window is cancelled on the spot.
//
// Equal or higher ranks are never bumped, and neither is a meeting that has
// already started. Each bump is recorded in `reschedule_requests` and in the
// audit log, and e-mailed through the normal notification outbox.
//
// Roles come first. Each role has a `priority_boost` (a tier; Manager = 1): a
// meeting's EFFECTIVE rank is its type's rank lifted by the largest boost among
// its organizer and attendees (see lib/priority-rank). A meeting with a manager
// in it therefore outranks every meeting without one, client meetings included;
// the meeting type only decides between meetings of the same tier.
// Everything below compares effective ranks.

// Largest boost among the given employees (0 when none are found).
export async function maxPriorityBoost(
  executor: DbExecutor,
  employeeIds: number[]
) {
  if (employeeIds.length === 0) return 0;

  const [row] = await executor
    .select({ boost: sql<number>`coalesce(max(${roles.priorityBoost}), 0)::int` })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(inArray(employee.employee_id, employeeIds));

  return row?.boost ?? 0;
}

// SQL for the effective rank of a booked `meeting` row joined to its
// `meeting_types` row. The meeting's people are its organizer and attendees.
export const bookedEffectiveRank = sql<number>`(
  ${meetingTypes.priorityRank} - ${RANK_SPAN}::int * coalesce((
    select max(${roles.priorityBoost})
    from ${employee}
    inner join ${roles} on ${roles.roleId} = ${employee.role_id}
    where ${employee.employee_id} = ${meeting.organizerEmployeeId}
      or ${employee.employee_id} in (
        select ${meeting_attendees.employee_id}
        from ${meeting_attendees}
        where ${meeting_attendees.meeting_id} = ${meeting.meeting_id}
      )
  ), 0)
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
  // Effective rank (type rank adjusted for the roles of its people).
  priorityRank: number;
};

// Meetings that hold part of the requested slot, locked for the rest of the
// transaction so two bookings cannot bump the same meeting.
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
      priorityRank: bookedEffectiveRank,
    })
    .from(meeting)
    .innerJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, meeting.meetingTypeId)
    )
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

// True when every holder may be bumped by a meeting of `claimantRank`.
export function canBumpAll(
  holders: SlotHolder[],
  claimantRank: number,
  now?: Date
) {
  return holders.every(
    (h) =>
      h.priorityRank > claimantRank &&
      !isSlotStartInPast(h.meetingDate, h.startTime, now)
  );
}

export type ReleasedSlot = {
  holder: SlotHolder;
  // True when the meeting could not wait (it starts within the response
  // window) and was cancelled on the spot; otherwise it is pending.
  cancelled: boolean;
  // Last moment its organizer can still change it.
  deadline: Date;
};

// The moment a pending bumped meeting is cancelled if nothing was changed:
// BUMP_RESPONSE_CUTOFF_MINUTES before it starts.
export function bumpDeadline(meetingDate: string, startTime: string) {
  const [y, mo, d, h, mi] = appWallClockToUtc(meetingDate, startTime);

  return new Date(
    Date.UTC(y, mo - 1, d, h, mi) - BUMP_RESPONSE_CUTOFF_MINUTES * 60_000
  );
}

// Cancels meetings whose organizer agreed to give the slot up (no relocation:
// they asked for it to be freed). Returns the cancellation e-mails to send.
export async function cancelYielded(
  tx: Tx,
  holders: { meetingId: number }[],
  actorEmployeeId: number
): Promise<number[]> {
  const notificationIds: number[] = [];

  for (const holder of holders) {
    await tx
      .update(meeting)
      .set({
        meetingStatusId: MEETING_STATUS.CANCELLED,
        updated_at: new Date(),
      })
      .where(eq(meeting.meeting_id, holder.meetingId));

    await createAuditLog(
      holder.meetingId,
      AUDIT_ACTION.CANCELLED,
      "Cancelled: organizer approved a room request for this slot",
      actorEmployeeId,
      tx
    );

    notificationIds.push(
      await queueMeetingNotification(tx, holder.meetingId, "CANCELLED")
    );
  }

  return notificationIds;
}

// Takes the slot away from every holder. The higher-priority meeting gets the
// room straight away; each bumped meeting keeps its room, date and time on
// record but is set to PENDING_RESCHEDULE (no longer holding the slot) until its
// organizer picks another room or time. A meeting that starts within the
// response window has no time to wait and is cancelled. Call before inserting
// the claiming meeting, so the room-overlap constraint is satisfied.
export async function releaseSlots(
  tx: Tx,
  holders: SlotHolder[],
  now: Date = new Date()
): Promise<ReleasedSlot[]> {
  const released: ReleasedSlot[] = [];

  for (const holder of holders) {
    const deadline = bumpDeadline(holder.meetingDate, holder.startTime);
    const cancelled = deadline.getTime() <= now.getTime();

    await tx
      .update(meeting)
      .set({
        meetingStatusId: cancelled
          ? MEETING_STATUS.CANCELLED
          : MEETING_STATUS.PENDING_RESCHEDULE,
        updated_at: new Date(),
      })
      .where(eq(meeting.meeting_id, holder.meetingId));

    released.push({ holder, cancelled, deadline });
  }

  return released;
}

// Records each bump against the meeting that took the slot and queues the
// e-mail to the bumped meeting's attendees. Returns the notification ids to
// dispatch after commit.
export async function recordBumps(
  tx: Tx,
  released: ReleasedSlot[],
  claimants: { meetingId: number; meetingDate: string }[],
  actorEmployeeId: number
): Promise<number[]> {
  const notificationIds: number[] = [];

  for (const { holder, cancelled, deadline } of released) {
    const claimant = claimants.find(
      (c) => c.meetingDate === holder.meetingDate
    );

    // Every released slot belongs to one of the requested dates.
    if (!claimant) continue;

    await tx.insert(reschedule_requests).values({
      bumped_meeting_id: holder.meetingId,
      claimant_meeting_id: claimant.meetingId,
      status: cancelled ? "AUTO_CANCELLED" : "PENDING",
      deadline,
      resolved_at: cancelled ? new Date() : null,
    });

    await createAuditLog(
      holder.meetingId,
      cancelled ? AUDIT_ACTION.BUMPED_CANCELLED : AUDIT_ACTION.BUMPED_PENDING,
      cancelled
        ? `Cancelled: slot claimed by higher-priority meeting #${claimant.meetingId} and too close to the start to reschedule`
        : `Slot claimed by higher-priority meeting #${claimant.meetingId}: waiting for the organizer to change the room or time`,
      actorEmployeeId,
      tx
    );

    notificationIds.push(
      await queueMeetingNotification(tx, holder.meetingId, "BUMPED")
    );
  }

  return notificationIds;
}

// Cancels every pending bumped meeting whose organizer did not change it in
// time (BUMP_RESPONSE_CUTOFF_MINUTES before it starts) and e-mails its
// attendees. Run by the cron tick; rows are claimed with SKIP LOCKED so several
// instances never cancel (or mail) the same meeting twice.
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

// Rooms that look busy for the slot but could be claimed by `role`: every
// meeting in them is of lower priority than the best type the role may book
// (its rank already includes the role's boost, see getAllowedMeetingTypes).
// Used only to show those rooms in the picker - the booking itself re-checks
// everything for the type actually chosen.
export async function getClaimableRooms(
  role: string,
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number,
  now?: Date
) {
  const allowed = await getAllowedMeetingTypes(role);

  if (allowed.length === 0) return [];

  const bestRank = Math.min(...allowed.map((t) => t.priorityRank));

  const holders = await db
    .select({
      roomId: meeting.room_id,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      priorityRank: bookedEffectiveRank,
    })
    .from(meeting)
    .innerJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, meeting.meetingTypeId)
    )
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
          h.priorityRank > bestRank &&
          !isSlotStartInPast(h.meetingDate, h.startTime, now)
      )
    )
    .map(([roomId]) => roomId);

  if (claimableIds.length === 0) return [];

  const rooms = await db
    .select()
    .from(room)
    .where(
      and(
        inArray(room.room_id, claimableIds),
        eq(room.availabilityStatusId, AVAILABILITY_STATUS.AVAILABLE),
        gte(room.room_capacity, participantCount)
      )
    );

  return rooms;
}
