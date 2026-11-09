// Date math for recurring series (pure, UTC-based on "YYYY-MM-DD" strings, so
// it never shifts a date across timezones). Shared by booking and by the
// confirmation e-mail so both always agree.

function daysInMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function formatDate(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isWeekend(date: Date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

// The supported recurrence frequencies, by NAME. The database ids of
// recurrence_frequency_master rows are only ever looked up, never assumed:
// a request's frequency_id is resolved to its name (frequencyFromName) before
// any date is computed.
export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;

export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

// The frequency a stored name stands for, or null when it is not supported.
export function frequencyFromName(name: unknown): RecurrenceFrequency | null {
  if (typeof name !== "string") return null;

  const normalized = name.trim().toUpperCase();

  return (RECURRENCE_FREQUENCIES as readonly string[]).includes(normalized)
    ? (normalized as RecurrenceFrequency)
    : null;
}

export class UnsupportedFrequencyError extends Error {
  constructor(frequency: unknown) {
    super(`Unsupported recurrence frequency: ${String(frequency)}`);
    this.name = "UnsupportedFrequencyError";
  }
}

// Daily means every working day: Saturdays and Sundays are skipped, so ten
// daily occurrences from a Monday span two Monday-to-Friday weeks.
// Weekly just adds 7 days. Monthly clamps to the target month's last day
// (e.g. Jan 31 -> Feb 28/29, not Mar 3) instead of letting setMonth() roll over.
// Anything else is an error, never silently another frequency.
// Most occurrences one series may have (also the request limit), and the
// largest "every N weeks".
export const MAX_SERIES_OCCURRENCES = 12;
export const MAX_RECURRENCE_INTERVAL = 12;

// "Every N" applies to WEEKLY only (every 1..12 weeks); DAILY (working days)
// and MONTHLY take no interval. Returns a reason when the combination is not
// supported, else null. Nothing is ever silently adjusted.
export function intervalProblem(frequency: RecurrenceFrequency, interval: unknown) {
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > MAX_RECURRENCE_INTERVAL
  ) {
    return `The interval must be a whole number from 1 to ${MAX_RECURRENCE_INTERVAL}.`;
  }

  if (interval !== 1 && frequency !== "WEEKLY") {
    return "Only weekly series can repeat every few weeks.";
  }

  return null;
}

function getNextDate(
  currentDate: Date,
  originalDay: number,
  frequency: RecurrenceFrequency,
  interval = 1
) {
  switch (frequency) {
    case "DAILY": {
      const next = new Date(currentDate);

      do {
        next.setUTCDate(next.getUTCDate() + 1);
      } while (isWeekend(next));

      return next;
    }

    case "WEEKLY": {
      // Same weekday as the first date, every `interval` weeks.
      const next = new Date(currentDate);
      next.setUTCDate(next.getUTCDate() + 7 * interval);
      return next;
    }

    case "MONTHLY": {
      const monthIndex = currentDate.getUTCFullYear() * 12 + currentDate.getUTCMonth() + 1;
      const targetYear = Math.floor(monthIndex / 12);
      const targetMonthIndex = monthIndex % 12;
      const day = Math.min(originalDay, daysInMonth(targetYear, targetMonthIndex));
      return new Date(Date.UTC(targetYear, targetMonthIndex, day));
    }

    default:
      throw new UnsupportedFrequencyError(frequency satisfies never);
  }
}

// The dates of a series: from `firstDate`, at most `occurrenceCount` of them,
// and with `until` none after that date (inclusive). Dates are plain
// "YYYY-MM-DD" values computed in UTC, so time zones and daylight-saving
// changes cannot shift them; each date is unique and increasing.
export function computeOccurrenceDates(
  firstDate: string,
  frequency: RecurrenceFrequency,
  occurrenceCount: number,
  options: { interval?: number; until?: string } = {}
) {
  // Checked at run time too: callers outside TypeScript's reach (stored data)
  // must never fall through to a default.
  if (frequencyFromName(frequency) !== frequency) {
    throw new UnsupportedFrequencyError(frequency);
  }

  const interval = options.interval ?? 1;
  const problem = intervalProblem(frequency, interval);

  if (problem) throw new RangeError(problem);

  const start = new Date(`${firstDate}T00:00:00.000Z`);
  const originalDay = start.getUTCDate();

  const dates: string[] = [];
  let currentDate = start;

  for (let i = 0; i < occurrenceCount; i++) {
    const date = formatDate(currentDate);

    if (options.until !== undefined && date > options.until) break;

    dates.push(date);
    currentDate = getNextDate(currentDate, originalDay, frequency, interval);
  }

  return dates;
}
