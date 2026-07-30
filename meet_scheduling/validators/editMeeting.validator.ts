import { z } from "zod";

export const editMeetingSchema = z.object({
  title: z
    .string()
    .min(3, "Title must be at least 3 characters")
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