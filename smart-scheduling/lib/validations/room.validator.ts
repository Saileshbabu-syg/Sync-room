import { z } from "zod";

import { MAX_INT4 } from "@/lib/constants";
import { NO_CONTROL_CHARS } from "@/lib/validations/date-time";

// Body of POST /api/rooms and PATCH /api/rooms/[room_id].
export const roomBodySchema = z.object({
  roomName: z
    .string()
    .trim()
    .min(1, "Room name is required.")
    .max(100)
    .regex(NO_CONTROL_CHARS, "Room name contains invalid characters"),

  roomCapacity: z
    .number()
    .int()
    .min(1, "Room capacity must be greater than 0.")
    .max(10_000, "Room capacity is unrealistically large."),

  roomLocation: z.string().trim().max(100).optional(),

  facilities: z.string().trim().max(255).optional(),

  roomDescription: z.string().trim().max(255).optional(),

  availabilityStatusId: z.number().int().min(1).max(MAX_INT4),
});
