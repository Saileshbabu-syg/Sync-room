import { eq } from "drizzle-orm";

import { db } from "@/db";
import { recurrence_frequency_master } from "@/db/schema";
import {
  MAX_SERIES_OCCURRENCES,
  computeOccurrenceDates,
  frequencyFromName,
  intervalProblem,
  isWeekend,
  type RecurrenceFrequency,
} from "@/lib/recurrence";
import { BookingError, createBooking } from "@/lib/services/booking.service";

// Kept here so existing imports of the series date math keep working.
export { computeOccurrenceDates };

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
  // At least one of the two: how many occurrences, and/or the last date the
  // series may run to (inclusive).
  occurrence_count?: number;
  end_date?: string;
  // "Every N weeks" (WEEKLY only); 1 when left out.
  interval?: number;
  participantEmployeeIds?: number[];
  optionalParticipantEmployeeIds?: number[];
  // Occurrences to leave out (must be dates of the generated series).
  skip_dates?: string[];
  // Online Teams Meeting for every occurrence (see createBooking).
  online?: boolean;
  notify?: boolean;
};

// The frequency a request's frequency_id stands for, looked up by id and
// interpreted by NAME (the ids differ between databases). An unknown id is
// 404; a row whose name is not a supported frequency is refused, never
// treated as some other frequency.
export async function resolveFrequency(
  frequencyId: number
): Promise<RecurrenceFrequency> {
  const [row] = await db
    .select({ name: recurrence_frequency_master.frequency_name })
    .from(recurrence_frequency_master)
    .where(eq(recurrence_frequency_master.frequency_id, frequencyId));

  if (!row) throw new BookingError("Recurrence frequency not found", 404);

  const frequency = frequencyFromName(row.name);

  if (!frequency) {
    throw new BookingError("This recurrence frequency is not supported.", 400);
  }

  return frequency;
}

// A series is booked through the same transaction (and the same conflict,
// maintenance, capacity and role rules) as a single meeting — either every
// occurrence is created or none is.
export async function createRecurringMeeting(data: CreateRecurringMeetingInput) {
  const frequency = await resolveFrequency(data.frequency_id);

  // A daily series runs Monday to Friday, so it cannot start on a weekend.
  // Refuse instead of silently moving the first meeting to another day.
  if (
    frequency === "DAILY" &&
    isWeekend(new Date(`${data.meeting_date}T00:00:00.000Z`))
  ) {
    throw new BookingError(
      "Daily meetings run Monday to Friday. Please choose a weekday as the start date.",
      400
    );
  }

  const interval = data.interval ?? 1;
  const intervalIssue = intervalProblem(frequency, interval);

  if (intervalIssue) throw new BookingError(intervalIssue, 400);

  if (data.occurrence_count === undefined && data.end_date === undefined) {
    throw new BookingError("Choose how many occurrences, or an end date.", 400);
  }

  if (data.end_date !== undefined && data.end_date < data.meeting_date) {
    throw new BookingError("The end date cannot be before the start date.", 400);
  }

  // With only an end date, one date more than allowed is generated so that a
  // series that would be too long is refused rather than silently cut short.
  const seriesDates = computeOccurrenceDates(
    data.meeting_date,
    frequency,
    data.occurrence_count ?? MAX_SERIES_OCCURRENCES + 1,
    { interval, until: data.end_date }
  );

  if (seriesDates.length > MAX_SERIES_OCCURRENCES) {
    throw new BookingError(
      `That end date gives more than ${MAX_SERIES_OCCURRENCES} occurrences. Choose an earlier end date.`,
      400
    );
  }

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

  const { meetings, recurringMeetingId, online } = await createBooking({
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
    optionalParticipantEmployeeIds: data.optionalParticipantEmployeeIds,
    requestedOccurrences: seriesDates.length,
    recurrence: {
      frequencyId: data.frequency_id,
      // What is actually booked, which is less than requested when dates were
      // skipped.
      occurrenceCount: occurrenceDates.length,
      // The pattern and its exceptions, stored with the series (L-1, L-2).
      patternStartDate: data.meeting_date,
      interval,
      untilDate: data.end_date ?? null,
      skippedDates: [...skip].sort(),
    },
    online: data.online,
    notify: data.notify,
  });

  return { meetings, recurringMeetingId: recurringMeetingId!, online };
}
