import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import { appBookingSettings, groupSettings, meeting } from "@/db/schema";
import {
  DEFAULT_APP_BOOKING_POLICY,
  DEFAULT_GROUP_BOOKING_POLICY,
  findLimitViolation,
  limitViolationMessage,
  monthOf,
  resolveEffectivePolicy,
  weekOf,
  type AppBookingPolicy,
  type EffectivePolicy,
  type GroupBookingPolicy,
  type OvernightSetting,
} from "@/lib/booking-limits";
import { MEETING_STATUS } from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";

// Group-wide booking limits (per day / week / month): the database half.
// The rules themselves are in lib/booking-limits.ts.

// Meetings that use up a group's booking allowance. Cancelled and replaced
// (PREEMPTED) meetings do not. A meeting waiting to be rescheduled after a bump
// (PENDING_RESCHEDULE) still counts: it is a live booking of the group, so
// moving it is neutral and it is released if it ends up cancelled.
export const COUNTED_STATUSES: number[] = [
  MEETING_STATUS.SCHEDULED,
  MEETING_STATUS.COMPLETED,
  MEETING_STATUS.PENDING_RESCHEDULE,
];

// Namespace of the per-group advisory lock (first key of the two-int form; the
// room lock uses 7001). Always taken AFTER the room lock, so two bookings can
// never wait on each other's locks in opposite order.
const GROUP_LOCK_NAMESPACE = 7002;

// Serialises everything that counts or adds bookings for one group until the
// surrounding transaction ends, so two concurrent requests cannot both read
// "one slot left" and both book it.
export async function lockGroupBookings(tx: DbExecutor, groupId: number) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${GROUP_LOCK_NAMESPACE}, ${groupId})`
  );
}

export async function getAppBookingPolicy(
  executor: DbExecutor = db
): Promise<AppBookingPolicy> {
  const [row] = await executor.select().from(appBookingSettings);

  if (!row) return { ...DEFAULT_APP_BOOKING_POLICY };

  return {
    allowOvernight: row.allowOvernight,
    maxDurationMinutes: row.maxDurationMinutes,
    maxBookingsPerDay: row.maxBookingsPerDay,
    maxBookingsPerWeek: row.maxBookingsPerWeek,
    maxBookingsPerMonth: row.maxBookingsPerMonth,
  };
}

export async function getGroupBookingPolicy(
  groupId: number,
  executor: DbExecutor = db
): Promise<GroupBookingPolicy> {
  const [row] = await executor
    .select()
    .from(groupSettings)
    .where(eq(groupSettings.groupId, groupId));

  if (!row) return { ...DEFAULT_GROUP_BOOKING_POLICY };

  return {
    overnight: row.overnightPolicy as OvernightSetting,
    maxDurationMinutes: row.maxDurationMinutes,
    maxBookingsPerDay: row.maxBookingsPerDay,
    maxBookingsPerWeek: row.maxBookingsPerWeek,
    maxBookingsPerMonth: row.maxBookingsPerMonth,
  };
}

// The effective day / week / month limits of one group (the stricter of the
// application's and the group's), read from the database.
export async function effectiveLimitsForGroup(
  groupId: number,
  executor: DbExecutor = db
): Promise<Pick<EffectivePolicy, "perDay" | "perWeek" | "perMonth">> {
  const effective = resolveEffectivePolicy(
    await getAppBookingPolicy(executor),
    await getGroupBookingPolicy(groupId, executor)
  );

  return {
    perDay: effective.perDay,
    perWeek: effective.perWeek,
    perMonth: effective.perMonth,
  };
}

// The dates (one entry per meeting) the group already holds in [from, to].
// `excludeMeetingIds` leaves out meetings that are being moved or replaced by
// the booking being checked.
export async function countedMeetingDates(
  executor: DbExecutor,
  groupId: number,
  from: string,
  to: string,
  excludeMeetingIds: number[] = []
): Promise<string[]> {
  const rows = await executor
    .select({ date: meeting.meeting_date })
    .from(meeting)
    .where(
      and(
        eq(meeting.groupIdAtBooking, groupId),
        inArray(meeting.meetingStatusId, COUNTED_STATUSES),
        sql`${meeting.meeting_date} BETWEEN ${from} AND ${to}`,
        ...excludeMeetingIds.map((id) => ne(meeting.meeting_id, id))
      )
    );

  return rows.map((r) => r.date);
}

export type BookingLimitProblem = { status: number; message: string };

// Would adding `dates` to the group's bookings break a day / week / month
// limit? Call it inside the booking transaction AFTER lockGroupBookings.
//  - `dates`: the new booking's date, or every occurrence of a series.
//  - `moving`: when one existing meeting is being moved, its id and the date it
//    leaves (it is not counted twice, and a period it stays in is not checked).
export async function checkBookingLimits(
  executor: DbExecutor,
  input: {
    groupId: number | null;
    limits: Pick<EffectivePolicy, "perDay" | "perWeek" | "perMonth">;
    dates: string[];
    isSeries?: boolean;
    moving?: { meetingId: number; fromDate: string };
  }
): Promise<BookingLimitProblem | null> {
  const { groupId, limits, dates, moving } = input;

  // Nobody without an active group shares an allowance, so there is nothing to
  // count them against.
  if (groupId === null || dates.length === 0) return null;

  if (
    limits.perDay.value === null &&
    limits.perWeek.value === null &&
    limits.perMonth.value === null
  ) {
    return null;
  }

  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Widest period that matters: from the first date's week/month start to the
  // last date's week/month end.
  const from = [first, weekOf(first).start, monthOf(first).start].sort()[0];
  const to = [last, weekOf(last).end, monthOf(last).end].sort().at(-1)!;

  const existing = await countedMeetingDates(
    executor,
    groupId,
    from,
    to,
    moving ? [moving.meetingId] : []
  );

  const violation = findLimitViolation(limits, existing, dates, moving?.fromDate);

  return violation
    ? { status: 400, message: limitViolationMessage(violation, input.isSeries) }
    : null;
}
