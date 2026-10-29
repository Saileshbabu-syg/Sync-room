import { z } from "zod";

import { NO_CONTROL_CHARS } from "@/lib/validations/date-time";

export const editRoomSchema = z.object({
  room_name: z
    .string()
    .trim()
    .min(1, "Room name is required.")
    .max(100)
    .regex(NO_CONTROL_CHARS, "Room name contains invalid characters"),

  room_capacity: z
    .number()
    .int()
    .positive("Room capacity must be greater than 0.")
    .max(10_000, "Room capacity is unrealistically large."),

  roomLocation: z
    .string()
    .trim()
    .min(1, "Location is required.")
    .max(100),

  facilities: z.string().max(255).optional(),

  roomDescription: z.string().max(255).optional(),

  availabilityStatusId: z
    .number()
    .int()
    .positive("Availability status is required."),
});
