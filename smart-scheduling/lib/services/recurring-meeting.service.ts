import { BookingError, createBooking } from "@/lib/services/booking.service";

// Kept as an alias so callers that import the old name keep working.
export { BookingError as RecurringMeetingError };

type CreateRecurringMeetingInput = {
  title: string;
  room_id: number;
  meeting_date: string;
  start_time: string;
  end_time: string;
  organizerEmployeeId: number;
  // Current role of the signed-in organizer (never taken from the request body).
  organizerRole: string;
  participantCount: number;
  meetingTypeId: number;
  frequency_id: number;
  occurrence_count: number;
  participantEmployeeIds?: number[];
  // Occurrences to leave out (must be dates of the generated series).
  skip_dates?: string[];
  notify?: boolean;
};

function daysInMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function formatDate(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isWeekend(date: Date) {
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

// A series is booked through the same transaction (and the same conflict,
// maintenance, capacity and role rules) as a single meeting — either every
// occurrence is created or none is.
export async function createRecurringMeeting(data: CreateRecurringMeetingInput) {
  // A daily series runs Monday to Friday, so it cannot start on a weekend.
  // Refuse instead of silently moving the first meeting to another day.
  if (
    data.frequency_id === 1 &&
    isWeekend(new Date(`${data.meeting_date}T00:00:00.000Z`))
  ) {
    throw new BookingError(
      "Daily meetings run Monday to Friday. Please choose a weekday as the start date.",
      400
    );
  }

  const seriesDates = computeOccurrenceDates(
    data.meeting_date,
    data.frequency_id,
    data.occurrence_count
  );

  const skip = new Set(data.skip_dates ?? []);

  for (const date of skip) {
    if (!seriesDates.includes(date)) {
      throw new BookingError(
        `${date} is not one of the dates in this series`,
        400
      );
    }
  }

  const occurrenceDates = seriesDates.filter((d) => !skip.has(d));

  if (occurrenceDates.length === 0) {
    throw new BookingError("No dates left to book", 400);
  }

  const { meetings, recurringMeetingId } = await createBooking({
    title: data.title,
    roomId: data.room_id,
    occurrenceDates,
    startTime: data.start_time,
    endTime: data.end_time,
    organizerEmployeeId: data.organizerEmployeeId,
    organizerRole: data.organizerRole,
    participantCount: data.participantCount,
    meetingTypeId: data.meetingTypeId,
    participantEmployeeIds: data.participantEmployeeIds,
    recurrence: {
      frequencyId: data.frequency_id,
      // What is actually booked, which is less than requested when dates were
      // skipped.
      occurrenceCount: occurrenceDates.length,
    },
    notify: data.notify,
  });

  return { meetings, recurringMeetingId: recurringMeetingId! };
}
