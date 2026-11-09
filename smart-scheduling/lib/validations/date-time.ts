// Shared date/time validation helpers for meeting booking schemas.

import { durationMinutes, isSlotStartInPast, nowInAppTimezone } from "@/lib/time";

// Shortest meeting anyone can book, reschedule to or be suggested. One rule
// for every path (forms, APIs, services).
export const MIN_MEETING_MINUTES = 15;
export const MIN_DURATION_MESSAGE = `Meeting duration must be at least ${MIN_MEETING_MINUTES} minutes.`;

// Duration is measured on the wall-clock times as booked (across midnight when the
// end is earlier than the start): meetings are stored and shown that way, and the zone has
// no daylight-saving jumps. Malformed values pass here; the field checks
// report them (refinements must not throw on them).
export function isLongEnough(start: string, end: string) {
  return (
    !TIME_REGEX.test(start.slice(0, 5)) ||
    !TIME_REGEX.test(end.slice(0, 5)) ||
    durationMinutes(start, end) >= MIN_MEETING_MINUTES
  );
}

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Months ahead a meeting can be booked.
export const BOOKING_WINDOW_MONTHS = 3;

// Last bookable date: `today` + 3 months, on the same day of the month or the
// last day of a shorter month (Nov 30 -> Feb 28, Jan 31 -> Apr 30), never
// rolling over into the month after.
export function bookingWindowEnd(today: string) {
  const [year, month, day] = today.split("-").map(Number);
  const monthIndex = year * 12 + (month - 1) + BOOKING_WINDOW_MONTHS;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return [
    targetYear,
    String(targetMonth + 1).padStart(2, "0"),
    String(Math.min(day, lastDay)).padStart(2, "0"),
  ].join("-");
}

// The booking window (today .. bookingWindowEnd), shared with the booking UI.
// "Today" is the date in the application's timezone, not UTC.
export function isWithinBookingWindow(value: string, now: Date = new Date()) {
  const today = nowInAppTimezone(now).date;

  return value >= today && value <= bookingWindowEnd(today);
}

// Meetings must start at least this long after "now" (booking, series, move,
// reschedule). Same rule in the booking form.
export const MIN_LEAD_MINUTES = 15;
export const LEAD_TIME_MESSAGE = `Meetings must start at least ${MIN_LEAD_MINUTES} minutes from now.`;

// True when the slot starts at least MIN_LEAD_MINUTES after `now`, comparing
// wall-clock date + time in the application's time zone (as stored). Malformed
// values pass here; the field checks report them.
export function hasMinimumLead(
  date: string,
  time: string,
  now: Date = new Date()
) {
  if (!DATE_REGEX.test(date) || !TIME_REGEX.test(time.slice(0, 5))) return true;

  const earliest = nowInAppTimezone(
    new Date(now.getTime() + MIN_LEAD_MINUTES * 60_000)
  );

  return `${date} ${time.slice(0, 5)}` >= `${earliest.date} ${earliest.time.slice(0, 5)}`;
}

// True when the slot has not started yet (the current minute is still OK).
export function isNotInPast(
  data: { meeting_date: string; start_time: string },
  now: Date = new Date()
) {
  // Malformed values are reported by the field-level checks; object-level
  // refinements still run in Zod 4, so they must not throw on them.
  if (!DATE_REGEX.test(data.meeting_date) || !TIME_REGEX.test(data.start_time)) {
    return true;
  }

  return !isSlotStartInPast(data.meeting_date, data.start_time, now);
}

// Titles go into varchar columns and e-mail subjects; NUL bytes make Postgres
// reject the insert, and other control characters have no business in a title.
export const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;
