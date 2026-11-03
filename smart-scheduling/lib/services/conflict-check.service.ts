import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting } from "@/db/schema";
import { SLOT_FREE_STATUSES } from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";
import { normalizeTime } from "@/lib/time";

// Overlap of the stored slot with the requested one, evaluated in SQL on real
// `time` values (never on "HH:MM" vs "HH:MM:SS" strings). Half-open intervals:
// a meeting that starts exactly when another ends does not conflict.
export function overlapsSlot(startTime: string, endTime: string) {
  return and(
    sql`${meeting.start_time} < ${normalizeTime(endTime)}::time`,
    sql`${meeting.end_time} > ${normalizeTime(startTime)}::time`
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
        eq(meeting.meeting_date, meetingDate),
        holdsSlot,
        overlapsSlot(startTime, endTime)
      )
    )
    .limit(1);

  return rows.length > 0;
}

// Subset of `meetingDates` on which the room is already taken for the slot.
export async function findConflictingDates(
  executor: DbExecutor,
  roomId: number,
  meetingDates: string[],
  startTime: string,
  endTime: string
): Promise<string[]> {
  if (meetingDates.length === 0) return [];

  const rows = await executor
    .selectDistinct({ meetingDate: meeting.meeting_date })
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        inArray(meeting.meeting_date, meetingDates),
        holdsSlot,
        overlapsSlot(startTime, endTime)
      )
    );

  return rows.map((r) => r.meetingDate).sort();
}
