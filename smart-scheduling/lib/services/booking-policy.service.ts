import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { groupRooms, groupSettings } from "@/db/schema";
import { PERMISSION } from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";
import { addDays } from "@/lib/report-period";
import { nowInAppTimezone, timeToSeconds } from "@/lib/time";

import {
  getPriorityContext,
  type PriorityContext,
} from "./group-context.service";

// What the booker's group allows beyond the system rules (which still apply):
//  * recurring series (permission `booking.recurring`)
//  * a longest meeting, how many days ahead, how many occurrences
//  * which rooms (no rows = every room)
// Someone with no usable group has no extra limits and every room. It is read
// from the database on every booking, never from the request.

export type BookingPolicy = {
  groupId: number | null;
  canBookRecurring: boolean;
  maxDurationMinutes: number | null;
  maxAdvanceDays: number | null;
  maxOccurrences: number | null;
  // null = every room.
  roomIds: number[] | null;
};

export const NO_LIMITS: Omit<BookingPolicy, "groupId" | "canBookRecurring"> = {
  maxDurationMinutes: null,
  maxAdvanceDays: null,
  maxOccurrences: null,
  roomIds: null,
};

export async function getBookingPolicy(
  employeeId: number,
  executor: DbExecutor = db,
  context?: PriorityContext
): Promise<BookingPolicy> {
  const standing = context ?? (await getPriorityContext(employeeId, executor));
  const canBookRecurring = standing.permissions.has(PERMISSION.BOOKING_RECURRING);

  if (standing.groupId === null) {
    return { groupId: null, canBookRecurring, ...NO_LIMITS };
  }

  const [settings] = await executor
    .select()
    .from(groupSettings)
    .where(eq(groupSettings.groupId, standing.groupId));

  const rooms = await executor
    .select({ roomId: groupRooms.roomId })
    .from(groupRooms)
    .where(and(eq(groupRooms.groupId, standing.groupId)));

  return {
    groupId: standing.groupId,
    canBookRecurring,
    maxDurationMinutes: settings?.maxDurationMinutes ?? null,
    maxAdvanceDays: settings?.maxAdvanceDays ?? null,
    maxOccurrences: settings?.maxOccurrences ?? null,
    roomIds: rooms.length > 0 ? rooms.map((r) => r.roomId) : null,
  };
}

export const canUseRoom = (policy: Pick<BookingPolicy, "roomIds">, roomId: number) =>
  policy.roomIds === null || policy.roomIds.includes(roomId);

export type PolicyProblem = { status: number; message: string };

const hoursText = (minutes: number) =>
  minutes % 60 === 0
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
    : `${minutes} minutes`;

// Pure rule check (no database): the first rule the booking breaks, or null.
export function checkBookingPolicy(
  policy: BookingPolicy,
  booking: {
    roomId: number;
    startTime: string;
    endTime: string;
    occurrenceDates: string[];
    isSeries: boolean;
    // How many occurrences were asked for (before skipped dates are removed).
    requestedOccurrences?: number;
  },
  today: string = nowInAppTimezone().date
): PolicyProblem | null {
  if (!canUseRoom(policy, booking.roomId)) {
    return { status: 403, message: "Your group is not allowed to book this room." };
  }

  if (booking.isSeries && !policy.canBookRecurring) {
    return {
      status: 403,
      message: "Your group is not allowed to book recurring meetings.",
    };
  }

  const minutes =
    (timeToSeconds(booking.endTime) - timeToSeconds(booking.startTime)) / 60;

  if (policy.maxDurationMinutes !== null && minutes > policy.maxDurationMinutes) {
    return {
      status: 400,
      message: `Your group can book meetings of at most ${hoursText(policy.maxDurationMinutes)}.`,
    };
  }

  if (policy.maxAdvanceDays !== null) {
    const last = [...booking.occurrenceDates].sort().at(-1);

    if (last && last > addDays(today, policy.maxAdvanceDays)) {
      return {
        status: 400,
        message: `Your group can book at most ${policy.maxAdvanceDays} days ahead.`,
      };
    }
  }

  const count = booking.requestedOccurrences ?? booking.occurrenceDates.length;

  if (
    booking.isSeries &&
    policy.maxOccurrences !== null &&
    count > policy.maxOccurrences
  ) {
    return {
      status: 400,
      message: `Your group can book at most ${policy.maxOccurrences} occurrences in a series.`,
    };
  }

  return null;
}
