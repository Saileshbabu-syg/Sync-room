import { z } from "zod";

export const editMeetingSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Meeting title is required")
    .max(200)
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
    .optional(),
});