import { z } from "zod";

import {
  DATE_REGEX,
  LEAD_TIME_MESSAGE,
  MIN_DURATION_MESSAGE,
  NO_CONTROL_CHARS,
  TIME_REGEX,
  hasMinimumLead,
  isLongEnough,
  isNotInPast,
  isValidCalendarDate,
  isWithinBookingWindow,
} from "@/lib/validations/date-time";
import {
  NOT_BOTH_LISTS_MESSAGE,
  overlappingParticipant,
  participantFields,
} from "@/lib/validations/participants";

export const meetingDateField = z
  .string()
  .regex(DATE_REGEX, "meeting_date must be in YYYY-MM-DD format")
  .refine(isValidCalendarDate, "meeting_date is not a valid calendar date")
  .refine(
    (value) => isWithinBookingWindow(value),
    "meeting_date must be between today and 3 months from today"
  );

export const timeFields = {
  start_time: z
    .string()
    .regex(TIME_REGEX, "start_time must be in HH:MM format"),

  end_time: z.string().regex(TIME_REGEX, "end_time must be in HH:MM format"),
};

// Headcount, organizer included. Bounded so it always fits the integer column
// (the same cap the room search uses).
export const MAX_PARTICIPANT_COUNT = 10_000;

export const participantCountField = z
  .number()
  .int()
  .positive()
  .max(MAX_PARTICIPANT_COUNT, `At most ${MAX_PARTICIPANT_COUNT} participants`);

// The organizer and the status are decided by the server (session identity and
// "Scheduled"), so the request does not carry them any more. Unknown keys such
// as the legacy `organizer_employee_id` / `meeting_status_id` are ignored.
export const createMeetingSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(200)
      .regex(NO_CONTROL_CHARS, "Title contains invalid characters"),

    meeting_date: meetingDateField,

    room_id: z.number().int().positive(),
    participant_count: participantCountField,
    meeting_type_id: z.number().int().positive(),

    ...timeFields,

    ...participantFields,

    // Online Teams Meeting: optional, off unless asked for.
    onlineMeeting: z.boolean().optional(),
  })
  .refine((data) => !overlappingParticipant(data), {
    message: NOT_BOTH_LISTS_MESSAGE,
    path: ["optionalParticipantEmployeeIds"],
  })
  .refine((data) => data.start_time < data.end_time, {
    message: "End time must be after start time",
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
  });
