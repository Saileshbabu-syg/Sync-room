import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  employee,
  groupPermissions,
  groups,
  meeting,
  reschedule_requests,
  roles,
  room,
  userGroups,
} from "@/db/schema";
import {
  AVAILABILITY_STATUS,
  BUMP_RESPONSE_CUTOFF_MINUTES,
  PERMISSION,
  PROTECTED_RANK,
  TOP_RANK,
  MEETING_STATUS,
} from "@/lib/constants";
import type { DbExecutor, Tx } from "@/lib/db-types";
import { appWallClockToUtc, isSlotStartInPast } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { holdsSlot, overlapsAnySlot, overlapsSlot } from "./conflict-check.service";
import { getAllowedMeetingTypes } from "./meeting-type-access.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";

// Meeting-type booking priority.
//
// Every meeting type has a rank (1 = highest ... 5 = lowest). When a booking
// asks for a slot that is held by confirmed meetings:
//
//  * every overlapping meeting (partial overlaps included) is found and locked
//    before anything is changed;
//  * the booking may proceed only if its meeting type has a STRICTLY higher
//    rank (a smaller number) than EVERY holder AND none has started. Equal rank
//    is first-confirmed-wins;
//  * two group permissions bend that, both Leadership's by default and both
//    counting required and optional participants alike:
//      - booking.outranks: a booking that invites a member beats every meeting
//        type (rank TOP_RANK) and takes the room from anything not protected;
//      - booking.protected: a held meeting that invites a member can never be
//        taken over, not even by an outranking booking (rank PROTECTED_RANK);
//  * each holder is set to PREEMPTED in the same transaction that inserts the
//    new booking, with an append-only booking_priority_history row, an audit
//    log entry and an e-mail to the preempted meeting's attendees.
//
// PREEMPTED is final. Meetings already waiting in PENDING_RESCHEDULE from the
// earlier engine still use the reschedule flow below until they are resolved.

// SQL: a booked meeting's rank - PROTECTED_RANK if any attendee is now in a
// group with booking.protected, otherwise its meeting type's rank. (An
// outranking meeting is not protected by that alone: outranking is about
// taking rooms, protection about keeping them.)
//
// Identifiers are written out in full on purpose: inside a `sql` template,
// drizzle drops the table prefix of a column when the outer query has a single
// table, which turns `a.employee_id = b.employee_id` into an ambiguous
// `employee_id = employee_id`. The outer meeting table is always "meeting".
export const bookedPriority = sql<number>`(case
  when exists (
    select 1
    from "meeting_attendees" as "bp_attendee"
    inner join "user_groups" as "bp_member"
      on "bp_member"."employee_id" = "bp_attendee"."employee_id"
      and "bp_member"."effective_until" is null
    inner join "groups" as "bp_group"
      on "bp_group"."id" = "bp_member"."group_id"
      and "bp_group"."is_active"
    inner join "group_permissions" as "bp_permission"
      on "bp_permission"."group_id" = "bp_group"."id"
      and "bp_permission"."permission_key" = ${PERMISSION.BOOKING_PROTECTED}
      and "bp_permission"."is_enabled"
    where "bp_attendee"."meeting_id" = "meeting"."meeting_id"
  ) then ${PROTECTED_RANK}::int
  else (
    select "bp_type"."priority_rank"
    from "meeting_types" as "bp_type"
    where "bp_type"."meeting_type_id" = "meeting"."meeting_type_id"
  )
end)::int`;

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
  // Rank (meeting type, or TOP_RANK for a priority guest); smaller outranks.
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
        holdsSlot,
        overlapsAnySlot(meetingDates, startTime, endTime)
      )
    )
    .orderBy(asc(meeting.meeting_date), asc(meeting.start_time))
    .for("update", { of: meeting });
}

// Whether any of these employees is in an active group that has the permission.
export async function hasMemberWithPermission(
  executor: DbExecutor,
  employeeIds: number[],
  permissionKey: string
): Promise<boolean> {
  if (employeeIds.length === 0) return false;

  const [row] = await executor
    .select({ one: sql<number>`1` })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .innerJoin(
      groupPermissions,
      and(
        eq(groupPermissions.groupId, groups.id),
        eq(groupPermissions.permissionKey, permissionKey),
        eq(groupPermissions.isEnabled, true)
      )
    )
    .where(
      and(
        inArray(userGroups.employeeId, employeeIds),
        isNull(userGroups.effectiveUntil),
        eq(groups.isActive, true)
      )
    )
    .limit(1);

  return row !== undefined;
}

// The rank a booking is judged on: its meeting type's, or TOP_RANK when a
// priority guest (a member of an outranking group) is invited.
export function claimantRank(typeRank: number, priorityGuest: boolean) {
  return priorityGuest ? TOP_RANK : typeRank;
}

// Why one held meeting stops a booking from taking its slot.
//  * PROTECTED_MEETING - it includes a member whose group protects its meetings;
//  * EQUAL_PRIORITY    - same rank: first confirmed wins;
//  * LOWER_PRIORITY    - the held meeting outranks the booking;
//  * MEETING_STARTED   - the booking does outrank it, but it is already running.
export const PRIORITY_BLOCK = {
  PROTECTED_MEETING: "PROTECTED_MEETING",
  EQUAL_PRIORITY: "EQUAL_PRIORITY",
  LOWER_PRIORITY: "LOWER_PRIORITY",
  MEETING_STARTED: "MEETING_STARTED",
} as const;

export type PriorityBlockCode = (typeof PRIORITY_BLOCK)[keyof typeof PRIORITY_BLOCK];

export type PriorityConflict = {
  code: PriorityBlockCode;
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  // Rank of the booking and of the meeting in the way (smaller outranks).
  claimantPriority: number;
  holderPriority: number;
  // Human-readable explanation, safe to show to the user.
  reason: string;
};

const clock = (time: string) => time.slice(0, 5);

function describeRank(rank: number) {
  return rank === TOP_RANK
    ? "top priority (a priority guest is invited)"
    : `priority ${rank}`;
}

// The held meetings that STOP a booking of `rank` from taking their slot, each
// with the priority condition that decides it. Empty = the booking may take
// every holder's slot. This is the one place the rule lives: single bookings,
// series, extensions and the explanations shown to the user all use it.
export function describePriorityConflicts(
  holders: SlotHolder[],
  rank: number,
  now?: Date
): PriorityConflict[] {
  const conflicts: PriorityConflict[] = [];

  for (const h of holders) {
    const outranked = h.priority > rank;
    const started = isSlotStartInPast(h.meetingDate, h.startTime, now);

    if (outranked && !started) continue;

    const where = `${h.meetingDate} ${clock(h.startTime)}-${clock(h.endTime)}`;
    let code: PriorityBlockCode;
    let why: string;

    if (h.priority === PROTECTED_RANK) {
      code = PRIORITY_BLOCK.PROTECTED_MEETING;
      why = `is a protected meeting (it includes a member whose group protects its meetings) and cannot be taken over`;
    } else if (!outranked && h.priority === rank) {
      code = PRIORITY_BLOCK.EQUAL_PRIORITY;
      why = `has the same ${describeRank(h.priority)} as this booking; equal priority does not replace an existing booking`;
    } else if (!outranked) {
      code = PRIORITY_BLOCK.LOWER_PRIORITY;
      why = `has a higher ${describeRank(h.priority)} than this booking (${describeRank(rank)})`;
    } else {
      code = PRIORITY_BLOCK.MEETING_STARTED;
      why = `has already started and cannot be replaced`;
    }

    conflicts.push({
      code,
      meetingId: h.meetingId,
      title: h.title,
      meetingDate: h.meetingDate,
      startTime: h.startTime,
      endTime: h.endTime,
      claimantPriority: rank,
      holderPriority: h.priority,
      reason: `${where}: "${h.title}" ${why}.`,
    });
  }

  return conflicts;
}

// One short text for a list of conflicts (the first few, then a count).
export function summarizePriorityConflicts(conflicts: PriorityConflict[]) {
  const shown = conflicts.slice(0, 3).map((c) => c.reason);

  if (conflicts.length > shown.length) {
    shown.push(`and ${conflicts.length - shown.length} more.`);
  }

  return shown.join(" ");
}

// True when a booking of `rank` may take the slot from EVERY holder.
export function canBumpAll(holders: SlotHolder[], rank: number, now?: Date) {
  return describePriorityConflicts(holders, rank, now).length === 0;
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

    const reason =
      incoming.priority === TOP_RANK
        ? `Preempted by booking #${claimant.meetingId}: a priority guest is invited, which outranks every meeting type`
        : `Preempted by ${incoming.groupName ?? "default-policy"} booking #${claimant.meetingId}: meeting type priority ${incoming.priority} outranks ${holder.priority}`;

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
  // The room list comes before a type is picked, so judge by the best meeting
  // type this person may book.
  const [person] = await db
    .select({ roleName: roles.roleName })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(eq(employee.employee_id, employeeId));

  if (!person) return [];

  const allowed = await getAllowedMeetingTypes({ employeeId, roleName: person.roleName });

  if (allowed.length === 0) return [];

  const claimant = {
    priority: Math.min(...allowed.map((t) => t.priorityRank)),
  };

  const holders = await db
    .select({
      roomId: meeting.room_id,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      priority: bookedPriority,
    })
    .from(meeting)
    .where(
      and(holdsSlot, overlapsSlot(meetingDate, startTime, endTime))
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
        eq(room.availabilityStatusId, AVAILABILITY_STATUS.AVAILABLE),
        isNull(room.archived_at)
      )
    );
}
