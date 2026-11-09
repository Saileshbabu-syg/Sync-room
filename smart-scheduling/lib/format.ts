import { APP_TIMEZONE } from "@/lib/constants";

// How dates and times are shown, everywhere in the UI.
//
// Meeting dates and times are wall-clock values in APP_TIMEZONE ("2026-11-05",
// "14:30:00"); they are formatted as they are, never converted, so the result
// does not depend on the server's or the viewer's timezone. Instants (a
// timestamp column) are shown in APP_TIMEZONE.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const instantFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: APP_TIMEZONE,
});

// "2026-11-05" -> "Thu, 5 Nov 2026". Anything else is returned unchanged.
export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";

  const match = DATE.exec(value);

  if (!match) return value;

  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  return Number.isNaN(ms) ? value : dateFormat.format(ms);
}

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)/;

// Hour (0-23) and minute -> "02:30 PM". 00:xx is 12:xx AM (midnight) and 12:xx
// is 12:xx PM (noon). Display only: times are stored and passed around as
// 24-hour "HH:mm" / "HH:mm:ss".
function to12Hour(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;

  return `${String(h12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${suffix}`;
}

// "14:30:00" | "14:30" -> "02:30 PM" (12-hour, no seconds). Anything that is
// not a valid wall-clock time is returned unchanged.
export function formatTime(value: string | null | undefined): string {
  if (!value) return "-";

  const match = WALL_CLOCK.exec(value);

  return match ? to12Hour(Number(match[1]), Number(match[2])) : value;
}

// A length of time in minutes: 120 -> "2 hours", 90 -> "1 hour 30 minutes",
// 45 -> "45 minutes".
export function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return (
    [
      hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
      minutes > 0 || hours === 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" ")
  );
}

// True when the end is earlier than the start, i.e. the meeting ends on the next
// day. Compares the "HH:mm" part, so "HH:mm" and "HH:mm:ss" mix safely; anything
// that is not a wall-clock time is never overnight.
function endsNextDay(start: string, end: string): boolean {
  const s = WALL_CLOCK.exec(start);
  const e = WALL_CLOCK.exec(end);

  return s !== null && e !== null && e[0] < s[0];
}

export const NEXT_DAY_LABEL = "next day";

// "01:00 AM" or, for a meeting that ends the day after it starts,
// "01:00 AM (next day)".
export function formatEndTime(start: string, end: string): string {
  return endsNextDay(start, end)
    ? `${formatTime(end)} (${NEXT_DAY_LABEL})`
    : formatTime(end);
}

// "02:30 PM - 03:30 PM", or "11:00 PM - 01:00 AM (next day)".
export function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)} - ${formatEndTime(start, end)}`;
}

// An instant (e.g. when something was created), in APP_TIMEZONE:
// "5 Nov 2026, 02:30 PM".
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "-";

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  const parts = instantFormat.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  return `${get("day")} ${get("month")} ${get("year")}, ${to12Hour(
    Number(get("hour")),
    Number(get("minute"))
  )}`;
}
