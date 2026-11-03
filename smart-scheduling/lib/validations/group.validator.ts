import { z } from "zod";

import { ALL_PERMISSIONS, MAX_INT4 } from "@/lib/constants";

const name = z
  .string()
  .trim()
  .min(1, "Group name is required.")
  .max(100, "Group name must be 100 characters or fewer.");

const description = z
  .string()
  .trim()
  .max(500, "Description must be 500 characters or fewer.")
  .nullish()
  .transform((v) => (v ? v : null));

const priority = z
  .number({ error: "Priority must be a number." })
  .int("Priority must be a whole number.")
  .min(1, "Priority must be at least 1 (highest).")
  .max(1000, "Priority must be at most 1000.");

// Only known keys may be stored; anything else is rejected, not ignored.
const permissions = z
  .array(z.enum(ALL_PERMISSIONS as [string, ...string[]]))
  .max(ALL_PERMISSIONS.length);

// Meeting types this group may book (ids of the existing meeting_types rows).
const meetingTypeIds = z
  .array(z.number().int().min(1).max(MAX_INT4))
  .max(100);

// Limits a group puts on its bookings; null/absent = no extra limit. They can
// only tighten the system limits (3 months ahead, 12 occurrences).
const limit = (min: number, max: number, what: string) =>
  z
    .number({ error: `${what} must be a number.` })
    .int(`${what} must be a whole number.`)
    .min(min, `${what} must be at least ${min}.`)
    .max(max, `${what} must be at most ${max}.`)
    .nullable();

const settings = z.object({
  maxDurationMinutes: limit(15, 1440, "Longest meeting (minutes)"),
  maxAdvanceDays: limit(1, 92, "Days ahead"),
  maxOccurrences: limit(1, 12, "Occurrences"),
});

// Rooms the group may book; an empty list means every room.
const roomIds = z.array(z.number().int().min(1).max(MAX_INT4)).max(500);

export const createGroupSchema = z.object({
  name,
  description,
  priority,
  isActive: z.boolean().default(true),
  permissions: permissions.default([]),
  meetingTypeIds: meetingTypeIds.default([]),
  settings: settings.default({
    maxDurationMinutes: null,
    maxAdvanceDays: null,
    maxOccurrences: null,
  }),
  roomIds: roomIds.default([]),
});

export const updateGroupSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    priority: priority.optional(),
    isActive: z.boolean().optional(),
    permissions: permissions.optional(),
    meetingTypeIds: meetingTypeIds.optional(),
    settings: settings.optional(),
    roomIds: roomIds.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const assignGroupSchema = z.object({
  groupId: z.number().int().min(1).max(MAX_INT4),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "An Entra group id must be a GUID."
  )
  .transform((v) => v.toLowerCase());

export const entraSettingsSchema = z
  .object({
    autoSyncEnabled: z.boolean(),
    intervalHours: z
      .number({ error: "Interval must be a number." })
      .int("Interval must be a whole number of hours.")
      .min(1, "Interval must be at least 1 hour.")
      .max(168, "Interval must be at most 168 hours (one week)."),
    mappings: z
      .array(
        z.object({
          entraGroupId: uuid,
          entraGroupName: z.string().trim().max(200).default(""),
          groupId: z.number().int().min(1).max(MAX_INT4),
        })
      )
      .max(100),
  })
  .refine(
    (v) => new Set(v.mappings.map((m) => m.entraGroupId)).size === v.mappings.length,
    "Each Entra group can be mapped only once."
  );
