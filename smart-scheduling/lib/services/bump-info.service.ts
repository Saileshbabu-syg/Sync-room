import { asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  employee,
  groups,
  meeting,
  meetingTypes,
  room,
} from "@/db/schema";

// Who took a booking's room. Read from booking_priority_history, the
// append-only record written when a booking is bumped, so the answer survives
// later group changes and cancellations. Nothing here changes any booking.

export type BumpInfo = {
  // The booking that was bumped.
  bumpedBookingId: number;
  // The booking that took the room.
  byBookingId: number;
  byName: string;
  byGroup: string | null;
  title: string;
  meetingType: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  reason: string;
  // ISO timestamp of the bump.
  bumpedAt: string;
};

const incoming = alias(meeting, "incoming_meeting");
const incomingOrganizer = alias(employee, "incoming_organizer");
const incomingGroup = alias(groups, "incoming_group");
const snapshotGroup = alias(groups, "incoming_snapshot_group");

// Bump details for each of the given bookings that was bumped. A booking is
// only bumped once; if history ever holds several rows the latest wins.
export async function getBumpInfo(
  bookingIds: number[]
): Promise<Map<number, BumpInfo>> {
  const byBooking = new Map<number, BumpInfo>();

  if (bookingIds.length === 0) return byBooking;

  const rows = await db
    .select({
      bumpedBookingId: bookingPriorityHistory.affectedBookingId,
      byBookingId: bookingPriorityHistory.incomingBookingId,
      byName: incomingOrganizer.employee_name,
      byGroup: incomingGroup.name,
      snapshotGroup: snapshotGroup.name,
      title: incoming.title,
      meetingType: meetingTypes.meetingTypeName,
      roomName: room.room_name,
      meetingDate: incoming.meeting_date,
      startTime: incoming.start_time,
      endTime: incoming.end_time,
      reason: bookingPriorityHistory.reason,
      bumpedAt: bookingPriorityHistory.createdAt,
    })
    .from(bookingPriorityHistory)
    .innerJoin(
      incoming,
      eq(incoming.meeting_id, bookingPriorityHistory.incomingBookingId)
    )
    .innerJoin(
      incomingOrganizer,
      eq(incomingOrganizer.employee_id, incoming.organizerEmployeeId)
    )
    .innerJoin(room, eq(room.room_id, incoming.room_id))
    .innerJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, incoming.meetingTypeId)
    )
    .leftJoin(
      incomingGroup,
      eq(incomingGroup.id, bookingPriorityHistory.incomingGroupId)
    )
    .leftJoin(snapshotGroup, eq(snapshotGroup.id, incoming.groupIdAtBooking))
    .where(inArray(bookingPriorityHistory.affectedBookingId, bookingIds))
    .orderBy(
      desc(bookingPriorityHistory.createdAt),
      desc(bookingPriorityHistory.id)
    );

  for (const { snapshotGroup: snapshot, bumpedAt, ...row } of rows) {
    // Newest first, so the first row seen for a booking is the one to keep.
    if (byBooking.has(row.bumpedBookingId)) continue;

    byBooking.set(row.bumpedBookingId, {
      ...row,
      // Older rows say "Preempted by ..."; people see "Replaced by ...".
      reason: row.reason.replace(/^Preempted by/, "Replaced by"),
      byGroup: row.byGroup ?? snapshot,
      bumpedAt: bumpedAt.toISOString(),
    });
  }

  return byBooking;
}

// The other direction: for a booking that took a room, the bookings it
// replaced. Same history rows, so original and replacement always agree.
export type ReplacedBooking = {
  bookingId: number;
  title: string;
  organizerName: string;
  organizerGroup: string | null;
  meetingType: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  reason: string;
};

const original = alias(meeting, "original_meeting");
const originalOrganizer = alias(employee, "original_organizer");
const originalGroup = alias(groups, "original_group");

export async function getReplacedBookings(
  bookingIds: number[]
): Promise<Map<number, ReplacedBooking[]>> {
  const byBooking = new Map<number, ReplacedBooking[]>();

  if (bookingIds.length === 0) return byBooking;

  const rows = await db
    .select({
      takerId: bookingPriorityHistory.incomingBookingId,
      bookingId: original.meeting_id,
      title: original.title,
      organizerName: originalOrganizer.employee_name,
      organizerGroup: originalGroup.name,
      meetingType: meetingTypes.meetingTypeName,
      roomName: room.room_name,
      meetingDate: original.meeting_date,
      startTime: original.start_time,
      endTime: original.end_time,
      reason: bookingPriorityHistory.reason,
    })
    .from(bookingPriorityHistory)
    .innerJoin(
      original,
      eq(original.meeting_id, bookingPriorityHistory.affectedBookingId)
    )
    .innerJoin(
      originalOrganizer,
      eq(originalOrganizer.employee_id, original.organizerEmployeeId)
    )
    .innerJoin(room, eq(room.room_id, original.room_id))
    .innerJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, original.meetingTypeId)
    )
    .leftJoin(
      originalGroup,
      eq(originalGroup.id, bookingPriorityHistory.previousGroupId)
    )
    .where(inArray(bookingPriorityHistory.incomingBookingId, bookingIds))
    .orderBy(asc(original.start_time), asc(original.meeting_id));

  for (const { takerId, reason, ...row } of rows) {
    byBooking.set(takerId, [
      ...(byBooking.get(takerId) ?? []),
      { ...row, reason: reason.replace(/^Preempted by/, "Replaced by") },
    ]);
  }

  return byBooking;
}
