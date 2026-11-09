// Time helpers for meeting slots.
//
// Postgres returns `time` columns as "HH:MM:SS" while the API accepts "HH:MM".
// Comparing those two as strings is wrong ("11:00" < "11:00:00"), so every
// comparison goes through seconds-since-midnight instead.
//
// Slots are half-open intervals [start, end): a meeting may start exactly when
// another one ends.
//
// Overnight slots: a meeting row keeps ONE date (the day it starts) and two
// wall-clock times. When the end time is earlier than the start time the meeting
// ends on the NEXT calendar day (23:00 -> 01:00). Equal times are a zero-length
// slot and are never valid, so a meeting is always shorter than 24 hours and the
// end date never needs its own column. Everything that needs a real end
// (conflicts, reminders, calendar, Teams, "has it ended") derives it here, or in
// SQL with the same rule (lib/services/conflict-check.service.ts).

import { APP_TIMEZONE } from "@/lib/constants";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

// "HH:MM" | "HH:MM:SS" -> "HH:MM:SS". Throws on anything else.
export function normalizeTime(value: string): string {
  const match = TIME_PATTERN.exec(value);

  if (!match) {
    throw new Error(`Invalid time value: ${value}`);
  }

  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}

export function timeToSeconds(value: string): number {
  const [h, m, s] = normalizeTime(value).split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

// Half-open interval overlap: [aStart, aEnd) vs [bStart, bEnd).
export function timeRangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  return (
    timeToSeconds(aStart) < timeToSeconds(bEnd) &&
    timeToSeconds(aEnd) > timeToSeconds(bStart)
  );
}

// True when the slot ends on the day after it starts (end earlier than start).
export function isOvernightSlot(start: string, end: string): boolean {
  return timeToSeconds(end) < timeToSeconds(start);
}

const SECONDS_PER_DAY = 24 * 3600;
const DAY_MS = SECONDS_PER_DAY * 1000;

// Length of the slot in minutes, across midnight when the slot is overnight.
export function durationMinutes(start: string, end: string): number {
  const seconds = timeToSeconds(end) - timeToSeconds(start);

  return (seconds < 0 ? seconds + SECONDS_PER_DAY : seconds) / 60;
}

// "YYYY-MM-DD" plus whole days (calendar arithmetic, no time zone involved).
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);

  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The calendar date the slot ends on: the start date, or the next day for an
// overnight slot.
export function slotEndDate(date: string, start: string, end: string): string {
  return isOvernightSlot(start, end) ? addCalendarDays(date, 1) : date;
}

// A slot as a pair of wall-clock instants (milliseconds, the wall clock read as
// UTC so no zone is involved: the application's zone has no daylight saving).
// Half-open [startMs, endMs).
export type SlotBounds = { startMs: number; endMs: number };

export function slotBounds(date: string, start: string, end: string): SlotBounds {
  const [y, m, d] = date.split("-").map(Number);
  const dayMs = Date.UTC(y, m - 1, d);

  return {
    startMs: dayMs + timeToSeconds(start) * 1000,
    endMs:
      dayMs +
      timeToSeconds(end) * 1000 +
      (isOvernightSlot(start, end) ? DAY_MS : 0),
  };
}

export function boundsOverlap(a: SlotBounds, b: SlotBounds): boolean {
  return a.startMs < b.endMs && a.endMs > b.startMs;
}

// "YYYY-MM-DD HH:MM:SS" wall-clock timestamps of a slot, for SQL comparisons.
export function slotTimestamps(date: string, start: string, end: string) {
  return {
    start: `${date} ${normalizeTime(start)}`,
    end: `${slotEndDate(date, start, end)} ${normalizeTime(end)}`,
  };
}

// Current wall-clock date ("YYYY-MM-DD") and time ("HH:MM:SS") in APP_TIMEZONE.
export function nowInAppTimezone(now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

// True when the slot starts before the current minute (the current minute
// itself is still bookable).
export function isSlotStartInPast(
  meetingDate: string,
  startTime: string,
  now: Date = new Date()
): boolean {
  const current = nowInAppTimezone(now);

  if (meetingDate !== current.date) {
    return meetingDate < current.date;
  }

  return timeToSeconds(startTime) < timeToSeconds(current.time.slice(0, 5));
}

// True once the meeting's end has been reached. An overnight meeting ends on
// the day after its date.
export function isMeetingEnded(
  meetingDate: string,
  startTime: string,
  endTime: string,
  now: Date = new Date()
): boolean {
  const current = nowInAppTimezone(now);
  const endDate = slotEndDate(meetingDate, startTime, endTime);

  if (endDate !== current.date) {
    return endDate < current.date;
  }

  return timeToSeconds(endTime) <= timeToSeconds(current.time);
}

// Offset (ms) of APP_TIMEZONE from UTC at the given instant.
function appTimezoneOffsetMs(instant: number) {
  const { date, time } = nowInAppTimezone(new Date(instant));
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);

  return Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(instant / 1000) * 1000;
}

// A wall-clock date + time in APP_TIMEZONE (how meetings are stored and shown)
// -> [year, month, day, hour, minute] in UTC. Independent of the server's own
// timezone, so a calendar invite lands at the same moment on any host.
export function appWallClockToUtc(
  date: string,
  time: string
): [number, number, number, number, number] {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);

  let utc = wall - appTimezoneOffsetMs(wall);
  utc = wall - appTimezoneOffsetMs(utc);

  const u = new Date(utc);

  return [
    u.getUTCFullYear(),
    u.getUTCMonth() + 1,
    u.getUTCDate(),
    u.getUTCHours(),
    u.getUTCMinutes(),
  ];
}
