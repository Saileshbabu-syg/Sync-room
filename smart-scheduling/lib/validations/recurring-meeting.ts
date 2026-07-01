import { z } from "zod";

export const recurringMeetingSchema = z.object({
  title: z.string().min(3),

  room_id: z.number(),

  meeting_date: z.string(),

  start_time: z.string(),

  end_time: z.string(),

  frequency_id: z.number(),

  occurrence_count: z.number().min(1),
});