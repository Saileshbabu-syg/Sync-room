import { computeOccurrenceDates, isWeekend } from "@/lib/recurrence";
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
  occurrence_count: number;
  participantEmployeeIds?: number[];
  // Occurrences to leave out (must be dates of the generated series).
  skip_dates?: string[];
  notify?: boolean;
};

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
