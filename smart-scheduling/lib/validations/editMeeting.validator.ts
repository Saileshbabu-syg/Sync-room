import { z } from "zod";

import {
  MIN_DURATION_MESSAGE,
  NO_CONTROL_CHARS,
  TIME_REGEX,
  isLongEnough,
} from "@/lib/validations/date-time";
import { participantCountField } from "@/lib/validations/meeting.validator";
import {
  NOT_BOTH_LISTS_MESSAGE,
  overlappingParticipant,
  participantFields,
} from "@/lib/validations/participants";

// Which occurrences of a recurring series an edit or cancellation is for
// ("single" for a meeting that is not part of a series).
export const scopeField = z.enum(["single", "following", "series"]).default("single");

export const editMeetingSchema = z
  .object({
  title: z
    .string()
    .trim()
    .min(1, "Meeting title is required")
    .max(200)
    .regex(NO_CONTROL_CHARS, "Title contains invalid characters")
    .optional(),

  participantCount: participantCountField.optional(),

  meetingTypeId: z
    .number()
    .int()
    .positive()
    .optional(),

  ...participantFields,

  scope: scopeField,

  // A new room and/or time of day for every occurrence in scope (each keeps
  // its date). To move one meeting to another date, use the reschedule route.
  room_id: z.number().int().positive().optional(),
  start_time: z.string().regex(TIME_REGEX, "start_time must be in HH:MM format").optional(),
  end_time: z.string().regex(TIME_REGEX, "end_time must be in HH:MM format").optional(),
  })
  .refine((data) => !overlappingParticipant(data), {
    message: NOT_BOTH_LISTS_MESSAGE,
    path: ["optionalParticipantEmployeeIds"],
  })
  .refine(
    (data) => (data.start_time === undefined) === (data.end_time === undefined),
    { message: "Give both start_time and end_time.", path: ["end_time"] }
  )
  .refine(
    (data) =>
      data.start_time === undefined ||
      data.end_time === undefined ||
      data.start_time !== data.end_time,
    { message: "End time must be different from the start time", path: ["end_time"] }
  )
  .refine(
    (data) =>
      data.start_time === undefined ||
      data.end_time === undefined ||
      isLongEnough(data.start_time, data.end_time),
    { message: MIN_DURATION_MESSAGE, path: ["end_time"] }
  );
