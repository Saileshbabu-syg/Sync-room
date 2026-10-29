import { z } from "zod";

import { durationMinutes } from "@/lib/time";
import { meetingDateField, timeFields } from "@/lib/validations/meeting.validator";
import { TIME_REGEX, isNotInPast } from "@/lib/validations/date-time";

// Field-level errors are reported separately; refinements must not throw on
// values that already failed them.
const longEnough = (start: string, end: string) =>
  !TIME_REGEX.test(start) ||
  !TIME_REGEX.test(end) ||
  durationMinutes(start, end) >= 15;

// Same field rules as booking, so the suggestions API can never offer a slot
// the booking API would refuse for being malformed, in the past or too far out.
export const suggestionsSchema = z
  .object({
    room_id: z.number().int().positive().optional(),
    meeting_date: meetingDateField,
    ...timeFields,
    participant_count: z.number().int().min(1).max(10_000),
  })
  .refine((d) => longEnough(d.start_time, d.end_time), {
    message: "Meeting duration must be at least 15 minutes.",
    path: ["end_time"],
  })
  .refine((d) => isNotInPast(d), {
    message: "Meetings cannot be booked in the past",
    path: ["start_time"],
  });

// Query-string version for the available-rooms page.
export const availableRoomsQuerySchema = z
  .object({
    date: meetingDateField,
    start: timeFields.start_time,
    end: timeFields.end_time,
    participants: z.coerce.number().int().min(1).max(10_000),
  })
  .refine((d) => longEnough(d.start, d.end), {
    message: "Meeting duration must be at least 15 minutes.",
    path: ["end"],
  })
  .refine((d) => isNotInPast({ meeting_date: d.date, start_time: d.start }), {
    message: "Meetings cannot be booked in the past",
    path: ["start"],
  });
