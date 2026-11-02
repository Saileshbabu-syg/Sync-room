import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  meeting,
  meetingTypes,
  reschedule_requests,
  room,
} from "@/db/schema";
import {
  AVAILABILITY_STATUS,
  MEETING_STATUS,
} from "@/lib/constants";
import type { DbExecutor, Tx } from "@/lib/db-types";
import { isSlotStartInPast } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { checkMeetingConflict, holdsSlot, overlapsSlot } from "./conflict-check.service";
import { getAllowedMeetingTypes } from "./meeting-type-access.service";
import { queueMeetingNotification } from "./notification.service";

// Priority-based scheduling.
//
// Every meeting type has a `priority_rank` (1 = highest ... 5 = lowest). When a
// booking asks for a slot that is held by meetings of strictly LOWER priority,
// those meetings are bumped instead of the booking being rejected:
//
//  * the bumped meeting is moved to another free room (same date and time,
//    enough capacity) when one exists - the organizer is told its new room;
//  * otherwise it is cancelled, and the organizer is e-mailed to book another
//    slot.
//
// Equal or higher ranks are never bumped, and neither is a meeting that has
// already started. Each bump is recorded in `reschedule_requests` and in the
// audit log, and e-mailed through the normal notification outbox.

export type SlotHolder = {
  meetingId: number;
  title: string;
  roomId: number;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
  organizerEmployeeId: number;
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
      priorityRank: meetingTypes.priorityRank,
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
  // Room the meeting was moved to; null when it had to be cancelled.
  relocatedRoomId: number | null;
};

async function relocate(
  tx: Tx,
  holder: SlotHolder
): Promise<number | null> {
  const candidates = await tx
    .select({ roomId: room.room_id })
    .from(room)
    .where(
      and(
        eq(room.availabilityStatusId, AVAILABILITY_STATUS.AVAILABLE),
        gte(room.room_capacity, holder.participantCount),
        sql`${room.room_id} <> ${holder.roomId}`
      )
    )
    // Smallest room that still fits, so large rooms stay free for large meetings.
    .orderBy(asc(room.room_capacity), asc(room.room_id));

  for (const { roomId } of candidates) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7001, ${roomId})`);

    const taken = await checkMeetingConflict(
      roomId,
      holder.meetingDate,
      holder.startTime,
      holder.endTime,
      tx
    );

    if (!taken) return roomId;
  }

  return null;
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

// Frees the slot of every holder (move or cancel). Call before inserting the
// claiming meeting, so the room-overlap constraint is satisfied.
export async function releaseSlots(
  tx: Tx,
  holders: SlotHolder[]
): Promise<ReleasedSlot[]> {
  const released: ReleasedSlot[] = [];

  for (const holder of holders) {
    const relocatedRoomId = await relocate(tx, holder);

    await tx
      .update(meeting)
      .set(
        relocatedRoomId !== null
          ? { room_id: relocatedRoomId, updated_at: new Date() }
          : {
              meetingStatusId: MEETING_STATUS.CANCELLED,
              updated_at: new Date(),
            }
      )
      .where(eq(meeting.meeting_id, holder.meetingId));

    released.push({ holder, relocatedRoomId });
  }

  return released;
}

// Records each bump against the meeting that took the slot and queues the
// organizer e-mail. Returns the notification ids to dispatch after commit.
export async function recordBumps(
  tx: Tx,
  released: ReleasedSlot[],
  claimants: { meetingId: number; meetingDate: string }[],
  actorEmployeeId: number
): Promise<number[]> {
  const notificationIds: number[] = [];

  for (const { holder, relocatedRoomId } of released) {
    const claimant = claimants.find(
      (c) => c.meetingDate === holder.meetingDate
    );

    // Every released slot belongs to one of the requested dates.
    if (!claimant) continue;

    await tx.insert(reschedule_requests).values({
      bumped_meeting_id: holder.meetingId,
      claimant_meeting_id: claimant.meetingId,
      status: relocatedRoomId !== null ? "AUTO_REALLOCATED" : "AUTO_CANCELLED",
      deadline: new Date(),
      resolved_at: new Date(),
    });

    await createAuditLog(
      holder.meetingId,
      relocatedRoomId !== null ? AUDIT_ACTION.BUMPED_MOVED : AUDIT_ACTION.BUMPED_CANCELLED,
      relocatedRoomId !== null
        ? `Moved to room #${relocatedRoomId}: slot claimed by higher-priority meeting #${claimant.meetingId}`
        : `Cancelled: slot claimed by higher-priority meeting #${claimant.meetingId}`,
      actorEmployeeId,
      tx
    );

    notificationIds.push(
      await queueMeetingNotification(tx, holder.meetingId, "BUMPED")
    );
  }

  return notificationIds;
}

// Rooms that look busy for the slot but could be claimed by `role`: every
// meeting in them is of lower priority than the best type the role may book.
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
      priorityRank: meetingTypes.priorityRank,
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
