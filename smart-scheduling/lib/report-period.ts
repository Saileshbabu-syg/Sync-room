import { nowInAppTimezone } from "@/lib/time";

// Reporting periods for the booking dashboard.
//
// Meetings are stored as wall-clock date + time in APP_TIMEZONE, so a period is
// just an inclusive pair of "YYYY-MM-DD" strings compared against
// meeting.meeting_date - no instants, no UTC conversion, hence nothing that can
// shift across a timezone boundary. All calendar maths runs on UTC dates built
// from those strings (never on the server's local timezone). "Today" is the
// current date in APP_TIMEZONE.
//
//  day    the chosen date
//  week   the chosen date and the 6 days after it (7 days)
//  month  the chosen date up to the day before the same date next month
//         (11 Nov -> 10 Dec); a date that does not exist next month is clamped
//         to that month's last day (31 Jan -> 27 Feb, as 28 Feb is the clamp)
//  range  an explicit start and end

export type PeriodMode = "day" | "week" | "month" | "range";

export type Period = {
  mode: PeriodMode;
  start: string; // inclusive
  end: string; // inclusive
  label: string;
};

export class PeriodError extends Error {}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const match = DATE.exec(date);

  if (!match) throw new PeriodError(`Invalid date: ${date}`);

  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);

  // Rejects 2026-02-30 and the like instead of rolling over.
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    throw new PeriodError(`Invalid date: ${date}`);
  }

  return ms;
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// `date` plus `days` calendar days.
export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

// The same day of the next calendar month, clamped to that month's length.
function sameDayNextMonth(date: string): string {
  const ms = toUtc(date);
  const d = new Date(ms);
  const lastOfNext = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)
  ).getUTCDate();

  return fromUtc(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      Math.min(d.getUTCDate(), lastOfNext)
    )
  );
}

export function weekFrom(start: string): { start: string; end: string } {
  return { start, end: addDays(start, 6) };
}

export function monthFrom(start: string): { start: string; end: string } {
  return { start, end: addDays(sameDayNextMonth(start), -1) };
}

type PeriodParams = {
  mode?: string | null;
  date?: string | null;
  start?: string | null;
  end?: string | null;
};

export function resolvePeriod(
  params: PeriodParams,
  now: Date = new Date()
): Period {
  const mode = (params.mode ?? "day") as PeriodMode;
  const today = nowInAppTimezone(now).date;

  switch (mode) {
    case "day": {
      const date = params.date || today;

      toUtc(date);

      return { mode, start: date, end: date, label: date };
    }
    case "week": {
      const date = params.date || today;

      toUtc(date);

      const { start, end } = weekFrom(date);

      return { mode, start, end, label: `${start} to ${end}` };
    }
    case "month": {
      const date = params.date || today;

      toUtc(date);

      const { start, end } = monthFrom(date);

      return { mode, start, end, label: `${start} to ${end}` };
    }
    case "range": {
      if (!params.start || !params.end) {
        throw new PeriodError("A start date and an end date are required.");
      }

      const a = toUtc(params.start);
      const b = toUtc(params.end);

      if (b < a) {
        throw new PeriodError("The end date cannot be before the start date.");
      }

      if ((b - a) / DAY_MS + 1 > MAX_RANGE_DAYS) {
        throw new PeriodError(
          `The date range cannot exceed ${MAX_RANGE_DAYS} days.`
        );
      }

      return {
        mode,
        start: params.start,
        end: params.end,
        label: `${params.start} to ${params.end}`,
      };
    }
    default:
      throw new PeriodError("Unknown period type.");
  }
}
