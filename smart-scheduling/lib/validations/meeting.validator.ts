import { z } from "zod";

import {
  DATE_REGEX,
  NO_CONTROL_CHARS,
  TIME_REGEX,
  isNotInPast,
  isValidCalendarDate,
  isWithinBookingWindow,
} from "@/lib/validations/date-time";

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
    participant_count: z.number().int().positive(),
    meeting_type_id: z.number().int().positive(),

    ...timeFields,

    participantEmployeeIds: z
      .array(z.number().int().positive())
      .max(100)
      .optional(),
  })
  .refine((data) => data.start_time < data.end_time, {
    message: "End time must be after start time",
    path: ["end_time"],
  })
  .refine((data) => isNotInPast(data), {
    message: "Meetings cannot be booked in the past",
    path: ["start_time"],
  });
