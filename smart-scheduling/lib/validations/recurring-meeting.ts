import { z } from "zod";

import { MAX_RECURRENCE_INTERVAL, MAX_SERIES_OCCURRENCES } from "@/lib/recurrence";
import {
  DATE_REGEX,
  LEAD_TIME_MESSAGE,
  MIN_DURATION_MESSAGE,
  NO_CONTROL_CHARS,
  hasMinimumLead,
  isLongEnough,
  isNotInPast,
  isValidCalendarDate,
} from "@/lib/validations/date-time";
import {
  NOT_BOTH_LISTS_MESSAGE,
  overlappingParticipant,
  participantFields,
} from "@/lib/validations/participants";
import {
  meetingDateField,
  participantCountField,
  timeFields,
} from "@/lib/validations/meeting.validator";

// Organizer and status come from the server, not the request body.
export const recurringMeetingSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .regex(NO_CONTROL_CHARS, "Title contains invalid characters"),

    room_id: z.number().int().positive(),

    meeting_date: meetingDateField,

    ...timeFields,

    participantCount: participantCountField,

    meetingTypeId: z.number().int().positive(),

    frequency_id: z.number().int().positive(),

    // How many occurrences, and/or the last date the series may run to
    // (inclusive). At least one of the two; with both, whichever ends first.
    occurrence_count: z.number().int().min(1).max(MAX_SERIES_OCCURRENCES).optional(),

    end_date: z
      .string()
      .regex(DATE_REGEX, "end_date must be in YYYY-MM-DD format")
      .refine(isValidCalendarDate, "end_date is not a valid calendar date")
      .optional(),

    // "Every N weeks" (WEEKLY only); 1 when left out.
    interval: z.number().int().min(1).max(MAX_RECURRENCE_INTERVAL).optional(),

    ...participantFields,

    // Online Teams Meeting for every occurrence: optional, off unless asked for.
    onlineMeeting: z.boolean().optional(),

    // Occurrence dates to leave out of the series ("book only the dates that
    // are free"). Each must be one of the dates the series generates; the
    // server checks that.
    skip_dates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(12)
      .optional(),
  })
  .refine((data) => !overlappingParticipant(data), {
    message: NOT_BOTH_LISTS_MESSAGE,
    path: ["optionalParticipantEmployeeIds"],
  })
  .refine((data) => data.start_time !== data.end_time, {
    message: "End time must be different from the start time",
    path: ["end_time"],
  })
  .refine((data) => isLongEnough(data.start_time, data.end_time), {
    message: MIN_DURATION_MESSAGE,
    path: ["end_time"],
  })
  .refine((data) => hasMinimumLead(data.meeting_date, data.start_time), {
    message: LEAD_TIME_MESSAGE,
    path: ["start_time"],
  })
  .refine((data) => isNotInPast(data), {
    message: "Meetings cannot be booked in the past",
    path: ["start_time"],
  })
  .refine(
    (data) => data.occurrence_count !== undefined || data.end_date !== undefined,
    {
      message: "Choose how many occurrences, or an end date.",
      path: ["occurrence_count"],
    }
  )
  .refine(
    (data) => data.end_date === undefined || data.end_date >= data.meeting_date,
    {
      message: "The end date cannot be before the start date.",
      path: ["end_date"],
    }
  );
