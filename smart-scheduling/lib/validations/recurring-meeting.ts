import { z } from "zod";

import {
  NO_CONTROL_CHARS,
  isNotInPast,
} from "@/lib/validations/date-time";
import { meetingDateField, timeFields } from "@/lib/validations/meeting.validator";

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

    participantCount: z.number().int().positive(),

    meetingTypeId: z.number().int().positive(),

    frequency_id: z.number().int().positive(),

    occurrence_count: z.number().int().min(1).max(12),

    participantEmployeeIds: z
      .array(z.number().int().positive())
      .max(100)
      .optional(),

    // Occurrence dates to leave out of the series ("book only the dates that
    // are free"). Each must be one of the dates the series generates; the
    // server checks that.
    skip_dates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(12)
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
