import { z } from "zod";

import { NO_CONTROL_CHARS } from "@/lib/validations/date-time";

export const editMeetingSchema = z.object({
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

  participantEmployeeIds: z
    .array(z.number().int().positive())
    .max(100)
    .optional(),
});
