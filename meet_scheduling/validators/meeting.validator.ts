import { z } from "zod";

export const createMeetingSchema = z.object({
  title: z.string().min(1, "Title is required"),
  meetingDate: z.string(),
  organizerEmployeeId: z.number().int().positive(),
  roomId: z.number().int().positive(),
  participantCount: z.number().int().positive(),
  meetingTypeId: z.number().int().positive(),
  meetingStatusId: z.number().int().positive(),
  startTime: z.string(),
  endTime: z.string(),
  participantEmployeeIds: z
  .array(z.number().int().positive())
  .optional(),
});