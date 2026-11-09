import { and, eq, notInArray, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting } from "@/db/schema";
import { SLOT_FREE_STATUSES } from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";
import {
  addCalendarDays,
  boundsOverlap,
  slotBounds,
  slotEndDate,
  slotTimestamps,
} from "@/lib/time";

// A stored meeting as two wall-clock `timestamp`s. The end is on the next
// calendar day when the end time is earlier than the start time (an overnight
// meeting, see lib/time.ts). This is the same expression the
// `meeting_no_room_overlap` exclusion constraint uses (migration 0043), so what
// the application checks and what the database enforces cannot drift apart.
export const meetingStartsAt = sql`(${meeting.meeting_date} + ${meeting.start_time})`;

export const meetingEndsAt = sql`(${meeting.meeting_date} + ${meeting.end_time} + CASE WHEN ${meeting.end_time} < ${meeting.start_time} THEN interval '1 day' ELSE interval '0 day' END)`;

// Overlap of a stored meeting with a slot starting on `date`, evaluated in SQL
// on real timestamps (never on "HH:MM" vs "HH:MM:SS" strings), across midnight
// in both directions: an overnight meeting that started the evening before
// blocks the early hours of `date`, and an overnight slot on `date` blocks the
// next morning. Half-open intervals: a meeting that starts exactly when another
// ends does not conflict.
export function overlapsSlot(date: string, startTime: string, endTime: string) {
  const slot = slotTimestamps(date, startTime, endTime);

  return and(
    // A meeting is shorter than a day, so only these start dates can overlap;
    // it keeps the (room, date) index usable.
    sql`${meeting.meeting_date} BETWEEN ${addCalendarDays(date, -1)}::date AND ${slotEndDate(date, startTime, endTime)}::date`,
    sql`${meetingStartsAt} < ${slot.end}::timestamp`,
    sql`${meetingEndsAt} > ${slot.start}::timestamp`
  );
}

// Cancelled meetings, and meetings waiting to be rescheduled after a bump, no
// longer hold their slot.
export const holdsSlot = notInArray(
  meeting.meetingStatusId,
  SLOT_FREE_STATUSES
);

export async function checkMeetingConflict(
  roomId: number,
  meetingDate: string,
  startTime: string,
  endTime: string,
  executor: DbExecutor = db
) {
  const rows = await executor
    .select({ meetingId: meeting.meeting_id })
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        holdsSlot,
        overlapsSlot(meetingDate, startTime, endTime)
      )
    )
    .limit(1);

  return rows.length > 0;
}

// Any of the candidate dates' slots overlapping a stored meeting, as one
// condition.
export function overlapsAnySlot(
  meetingDates: string[],
  startTime: string,
  endTime: string
) {
  return or(...meetingDates.map((d) => overlapsSlot(d, startTime, endTime)));
}

// Subset of `meetingDates` on which the room is already taken for the slot
// (each date's slot may run into the next day).
export async function findConflictingDates(
  executor: DbExecutor,
  roomId: number,
  meetingDates: string[],
  startTime: string,
  endTime: string,
  // Meetings being moved: they never conflict with their own current slot.
  excludeMeetingIds: number[] = []
): Promise<string[]> {
  if (meetingDates.length === 0) return [];

  const rows = await executor
    .select({
      date: meeting.meeting_date,
      start: meeting.start_time,
      end: meeting.end_time,
    })
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        holdsSlot,
        overlapsAnySlot(meetingDates, startTime, endTime),
        excludeMeetingIds.length > 0
          ? notInArray(meeting.meeting_id, excludeMeetingIds)
          : undefined
      )
    );

  const held = rows.map((r) => slotBounds(r.date, r.start, r.end));

  return [...new Set(meetingDates)]
    .filter((d) => {
      const candidate = slotBounds(d, startTime, endTime);

      return held.some((h) => boundsOverlap(candidate, h));
    })
    .sort();
}
