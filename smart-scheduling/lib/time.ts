// Time helpers for meeting slots.
//
// Postgres returns `time` columns as "HH:MM:SS" while the API accepts "HH:MM".
// Comparing those two as strings is wrong ("11:00" < "11:00:00"), so every
// comparison goes through seconds-since-midnight instead.
//
// Slots are half-open intervals [start, end): a meeting may start exactly when
// another one ends. Overnight slots (end before start) are not supported.

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

export function durationMinutes(start: string, end: string): number {
  return (timeToSeconds(end) - timeToSeconds(start)) / 60;
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

// True once the meeting's end time has been reached.
export function isMeetingEnded(
  meetingDate: string,
  endTime: string,
  now: Date = new Date()
): boolean {
  const current = nowInAppTimezone(now);

  if (meetingDate !== current.date) {
    return meetingDate < current.date;
  }

  return timeToSeconds(endTime) <= timeToSeconds(current.time);
}
