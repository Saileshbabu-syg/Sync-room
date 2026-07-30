import { z } from "zod";

export const conflictCheckSchema = z.object({
  room_id: z.number(),
  meeting_date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
});