// Booking policies: how the application-wide settings and a group's own
// settings combine, and the day / week / month booking-count rules.
//
// This file is pure (no database, no clock): every rule lives here once, and
// booking-policy.service / booking-limits.service only feed it data.
//
// -- Meanings of "no value" ----------------------------------------------------
//  * Application numeric settings: null = unlimited.
//  * Group numeric settings:       null = the group sets no limit of its own;
//                                  the application's limit (if any) applies.
//  * Group overnight policy: an explicit INHERIT / ALLOWED / NOT_ALLOWED, so
//    "inherit" never has to be guessed from a null.
//
// -- Resolution ------------------------------------------------------------------
//  * Overnight: application off => nobody may. Application on => the group's
//    NOT_ALLOWED forbids it; INHERIT and ALLOWED allow it.
//  * Longest meeting, bookings per day / week / month: the STRICTER of the
//    application and group values. A group's "unlimited" (null) can never lift a
//    finite application limit, and an application limit that is lowered later
//    tightens every group at once without rewriting any group setting.
//
// -- Counting (see countedStatuses in booking-limits.service) -------------------
//  * Limits are per GROUP (all its members together), never per employee.
//  * A meeting counts once, on the calendar date it STARTS (meeting_date), so a
//    meeting running past midnight is never counted twice.
//  * Day / week / month are calendar periods in the application timezone: a
//    meeting date is already a wall-clock date there, so no conversion is
//    needed. Weeks run Monday to Sunday; months are calendar months.
//  * Cancelled and replaced meetings do not count.

import { formatDate } from "@/lib/format";
import { addDays } from "@/lib/report-period";

export type OvernightSetting = "INHERIT" | "ALLOWED" | "NOT_ALLOWED";

export const OVERNIGHT_SETTINGS: readonly OvernightSetting[] = [
  "INHERIT",
  "ALLOWED",
  "NOT_ALLOWED",
];

export type AppBookingPolicy = {
  allowOvernight: boolean;
  // Minutes; null = unlimited.
  maxDurationMinutes: number | null;
  maxBookingsPerDay: number | null;
  maxBookingsPerWeek: number | null;
  maxBookingsPerMonth: number | null;
};

// What the application did before these settings existed: nothing extra.
export const DEFAULT_APP_BOOKING_POLICY: AppBookingPolicy = {
  allowOvernight: false,
  maxDurationMinutes: null,
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

export type GroupBookingPolicy = {
  overnight: OvernightSetting;
  // Minutes; null = no limit of the group's own.
  maxDurationMinutes: number | null;
  maxBookingsPerDay: number | null;
  maxBookingsPerWeek: number | null;
  maxBookingsPerMonth: number | null;
};

export const DEFAULT_GROUP_BOOKING_POLICY: GroupBookingPolicy = {
  overnight: "INHERIT",
  maxDurationMinutes: null,
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

// A resolved numeric limit, with where it comes from (for the error message).
export type EffectiveLimit = {
  value: number | null;
  source: "application" | "group" | null;
};

export type EffectivePolicy = {
  allowOvernight: boolean;
  maxDuration: EffectiveLimit;
  perDay: EffectiveLimit;
  perWeek: EffectiveLimit;
  perMonth: EffectiveLimit;
};

// The stricter of an application and a group limit; null = unlimited. A tie is
// attributed to the application (it is the boundary the group cannot cross).
export function stricter(
  application: number | null,
  group: number | null
): EffectiveLimit {
  if (application === null && group === null) {
    return { value: null, source: null };
  }

  if (application === null) return { value: group, source: "group" };

  if (group === null) return { value: application, source: "application" };

  return group < application
    ? { value: group, source: "group" }
    : { value: application, source: "application" };
}

export function resolveEffectivePolicy(
  app: AppBookingPolicy,
  group: GroupBookingPolicy
): EffectivePolicy {
  return {
    allowOvernight: app.allowOvernight && group.overnight !== "NOT_ALLOWED",
    maxDuration: stricter(app.maxDurationMinutes, group.maxDurationMinutes),
    perDay: stricter(app.maxBookingsPerDay, group.maxBookingsPerDay),
    perWeek: stricter(app.maxBookingsPerWeek, group.maxBookingsPerWeek),
    perMonth: stricter(app.maxBookingsPerMonth, group.maxBookingsPerMonth),
  };
}

// A group may not exceed the application's limits or enable what the
// application forbids. Returns the first problem as a message for the admin,
// or null. Used when a group (or the application) is SAVED; it is never used to
// change anything already stored.
export function groupPolicyProblem(
  app: AppBookingPolicy,
  group: GroupBookingPolicy
): string | null {
  if (group.overnight === "ALLOWED" && !app.allowOvernight) {
    return "Overnight bookings are turned off for the whole application, so this group cannot allow them. Turn them on under Application booking policies first.";
  }

  const numeric: [string, number | null, number | null][] = [
    ["Maximum meeting duration", group.maxDurationMinutes, app.maxDurationMinutes],
    ["Maximum bookings per day", group.maxBookingsPerDay, app.maxBookingsPerDay],
    ["Maximum bookings per week", group.maxBookingsPerWeek, app.maxBookingsPerWeek],
    ["Maximum bookings per month", group.maxBookingsPerMonth, app.maxBookingsPerMonth],
  ];

  for (const [label, groupValue, appValue] of numeric) {
    if (groupValue !== null && appValue !== null && groupValue > appValue) {
      return `${label} cannot be more than the application limit of ${appValue}.`;
    }
  }

  return null;
}

/* ------------------------------ calendar periods ---------------------------- */

// Monday of the week containing `date` ("YYYY-MM-DD"), and the Sunday after it.
export function weekOf(date: string): { start: string; end: string } {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(date, -((day + 6) % 7));

  return { start, end: addDays(start, 6) };
}

// First and last day of the calendar month containing `date`.
export function monthOf(date: string): { start: string; end: string } {
  const [y, m] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");

  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

export type LimitPeriod = "day" | "week" | "month";

export type LimitViolation = {
  period: LimitPeriod;
  limit: number;
  source: "application" | "group";
  // The booking date that went over, and what the period would hold.
  date: string;
  total: number;
  // The period's first / last day.
  periodStart: string;
  periodEnd: string;
};

type Limits = Pick<EffectivePolicy, "perDay" | "perWeek" | "perMonth">;

const inRange = (date: string, start: string, end: string) =>
  date >= start && date <= end;

// Which period would a booking on `date` push over a limit?
//  - `existing`: the dates (one entry per meeting) the group already holds. The
//    caller leaves out the meeting being moved, so a move is not counted twice.
//  - `added`: the dates the new booking (or every occurrence of a series) adds.
//  - `unchangedFrom`: when ONE meeting is being moved, the date it leaves. A
//    period that still contains that date does not gain a booking, so it is not
//    checked: a group that is already over a limit (the limit was lowered later)
//    can still move a meeting inside the same day/week/month.
// Returns the first violation in date order (day, then week, then month), or
// null. Every added date is checked against the periods around it, so a series
// with several occurrences in one week or month is judged as a whole.
export function findLimitViolation(
  limits: Limits,
  existing: string[],
  added: string[],
  unchangedFrom?: string
): LimitViolation | null {
  const periods: [LimitPeriod, EffectiveLimit, (date: string) => { start: string; end: string }][] = [
    ["day", limits.perDay, (d) => ({ start: d, end: d })],
    ["week", limits.perWeek, weekOf],
    ["month", limits.perMonth, monthOf],
  ];

  for (const date of [...added].sort()) {
    for (const [period, limit, boundsOf] of periods) {
      if (limit.value === null || limit.source === null) continue;

      const { start, end } = boundsOf(date);

      if (unchangedFrom && inRange(unchangedFrom, start, end)) continue;

      const total =
        existing.filter((d) => inRange(d, start, end)).length +
        added.filter((d) => inRange(d, start, end)).length;

      if (total > limit.value) {
        return {
          period,
          limit: limit.value,
          source: limit.source,
          date,
          total,
          periodStart: start,
          periodEnd: end,
        };
      }
    }
  }

  return null;
}

const plural = (n: number) => (n === 1 ? "booking" : "bookings");

// The message the person sees: which policy, who set it, and what it would hold.
export function limitViolationMessage(v: LimitViolation, isSeries = false): string {
  const who = v.source === "application" ? "The application allows" : "Your group can book";
  const where = isSeries ? "Occurrence on " : "";

  switch (v.period) {
    case "day":
      return `${who} at most ${v.limit} ${plural(v.limit)} per day for a group. ${where}${formatDate(v.date)} would have ${v.total}.`;
    case "week":
      return `${who} at most ${v.limit} ${plural(v.limit)} per week (Monday to Sunday) for a group. ${where}${formatDate(v.date)} falls in the week of ${formatDate(v.periodStart)}, which would have ${v.total}.`;
    case "month": {
      const label = new Date(`${v.periodStart}T00:00:00.000Z`).toLocaleDateString("en-GB", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });

      return `${who} at most ${v.limit} ${plural(v.limit)} per month for a group. ${where}${formatDate(v.date)} falls in ${label}, which would have ${v.total}.`;
    }
  }
}
