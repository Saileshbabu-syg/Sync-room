import { z } from "zod";

import { meetingDateField, timeFields } from "@/lib/validations/meeting.validator";
import {
  MIN_DURATION_MESSAGE,
  isLongEnough as longEnough,
  isNotInPast,
} from "@/lib/validations/date-time";

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
    message: MIN_DURATION_MESSAGE,
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
    message: MIN_DURATION_MESSAGE,
    path: ["end"],
  })
  .refine((d) => isNotInPast({ meeting_date: d.date, start_time: d.start }), {
    message: "Meetings cannot be booked in the past",
    path: ["start"],
  });
