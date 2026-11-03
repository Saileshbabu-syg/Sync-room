import { z } from "zod";

import { NO_CONTROL_CHARS } from "@/lib/validations/date-time";
import {
  NOT_BOTH_LISTS_MESSAGE,
  overlappingParticipant,
  participantFields,
} from "@/lib/validations/participants";

export const editMeetingSchema = z
  .object({
  title: z
    .string()
    .trim()
    .min(1, "Meeting title is required")
    .max(200)
    .regex(NO_CONTROL_CHARS, "Title contains invalid characters")
    .optional(),

  participantCount: z
    .number()
    .int()
    .positive()
    .optional(),

  meetingTypeId: z
    .number()
    .int()
    .positive()
    .optional(),

  ...participantFields,
  })
  .refine((data) => !overlappingParticipant(data), {
    message: NOT_BOTH_LISTS_MESSAGE,
    path: ["optionalParticipantEmployeeIds"],
  });
