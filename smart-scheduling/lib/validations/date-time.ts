// Shared date/time validation helpers for meeting booking schemas.

import { isSlotStartInPast, nowInAppTimezone } from "@/lib/time";

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

// Matches the booking UI's own window (today .. today + 3 months). "Today" is
// the date in the application's timezone, not UTC.
export function isWithinBookingWindow(value: string, now: Date = new Date()) {
  const today = new Date(`${nowInAppTimezone(now).date}T00:00:00.000Z`);

  const maxDate = new Date(today);
  maxDate.setUTCMonth(maxDate.getUTCMonth() + 3);

  const date = new Date(`${value}T00:00:00.000Z`);

  return date >= today && date <= maxDate;
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
