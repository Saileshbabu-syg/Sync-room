import { z } from "zod";

export const editRoomSchema = z.object({
  room_name: z
    .string()
    .trim()
    .min(1, "Room name is required."),

  room_capacity: z
    .number()
    .int()
    .positive("Room capacity must be greater than 0."),

  roomLocation: z
    .string()
    .trim()
    .min(1, "Location is required."),

  facilities: z.string().optional(),

  roomDescription: z.string().optional(),

  availabilityStatusId: z
    .number()
    .int()
    .positive("Availability status is required."),
});