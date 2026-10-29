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

// Daily means every working day: Saturdays and Sundays are skipped, so ten
// daily occurrences from a Monday span two Monday-to-Friday weeks.
// Weekly just adds 7 days. Monthly clamps to the target month's last day
// (e.g. Jan 31 -> Feb 28/29, not Mar 3) instead of letting setMonth() roll over.
function getNextDate(
  currentDate: Date,
  originalDay: number,
  frequencyId: number
) {
  switch (frequencyId) {
    case 1: {
      const next = new Date(currentDate);

      do {
        next.setUTCDate(next.getUTCDate() + 1);
      } while (isWeekend(next));

      return next;
    }

    case 2: {
      const next = new Date(currentDate);
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    }

    case 3: {
      const monthIndex = currentDate.getUTCFullYear() * 12 + currentDate.getUTCMonth() + 1;
      const targetYear = Math.floor(monthIndex / 12);
      const targetMonthIndex = monthIndex % 12;
      const day = Math.min(originalDay, daysInMonth(targetYear, targetMonthIndex));
      return new Date(Date.UTC(targetYear, targetMonthIndex, day));
    }

    default:
      return currentDate;
  }
}

export function computeOccurrenceDates(
  firstDate: string,
  frequencyId: number,
  occurrenceCount: number
) {
  const start = new Date(`${firstDate}T00:00:00.000Z`);
  const originalDay = start.getUTCDate();

  const dates: string[] = [];
  let currentDate = start;

  for (let i = 0; i < occurrenceCount; i++) {
    dates.push(formatDate(currentDate));
    currentDate = getNextDate(currentDate, originalDay, frequencyId);
  }

  return dates;
}
