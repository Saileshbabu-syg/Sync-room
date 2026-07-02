import { z } from "zod";

export const createMeetingSchema = z.object({
  title: z.string().min(1, "Title is required"),
  meeting_date: z.string(),
  organizer_employee_id: z.number().int().positive(),
  room_id: z.number().int().positive(),
  participant_count: z.number().int().positive(),
  meeting_type_id: z.number().int().positive(),
  meeting_status_id: z.number().int().positive(),
  start_time: z.string(),
  end_time: z.string(),
  participantEmployeeIds: z
  .array(z.number().int().positive())
  .optional(),
});