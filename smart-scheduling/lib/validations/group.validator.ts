import { z } from "zod";

import { OVERNIGHT_SETTINGS, type OvernightSetting } from "@/lib/booking-limits";
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

// Booking policies (lib/booking-limits.ts): the overnight choice and the
// per-day / week / month booking limits. Absent = leave as stored, so a client
// that does not know them can never reset them; null = no limit of the group's
// own (the application's limit, if any, still applies).
const settings = z.object({
  maxDurationMinutes: limit(15, 1440, "Maximum meeting duration (minutes)"),
  maxAdvanceDays: limit(1, 92, "Days ahead"),
  maxOccurrences: limit(1, 12, "Occurrences"),
  overnightPolicy: z
    .enum(OVERNIGHT_SETTINGS as [OvernightSetting, ...OvernightSetting[]], {
      error: "Overnight booking must be Inherit, Allowed or Not allowed.",
    })
    .optional(),
  maxBookingsPerDay: limit(1, 1000, "Maximum bookings per day").optional(),
  maxBookingsPerWeek: limit(1, 5000, "Maximum bookings per week").optional(),
  maxBookingsPerMonth: limit(1, 20000, "Maximum bookings per month").optional(),
});

// How a meeting type ranks when two bookings want the same room: 1 is the
// highest, 5 the lowest (the database enforces the same range).
export const updateMeetingTypeSchema = z.object({
  priorityRank: z
    .number({ error: "Priority must be a number." })
    .int("Priority must be a whole number.")
    .min(1, "Priority must be between 1 (highest) and 5 (lowest).")
    .max(5, "Priority must be between 1 (highest) and 5 (lowest)."),
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

// The sync interval is one of a few presets, stored as hours.
export const SYNC_INTERVAL_HOURS = [1, 24, 168, 720] as const;

export const entraSettingsSchema = z.object({
  autoSyncEnabled: z.boolean(),
  intervalHours: z
    .number({ error: "Interval must be a number." })
    .refine(
      (h) => (SYNC_INTERVAL_HOURS as readonly number[]).includes(h),
      "Choose 1 hour, 1 day, 1 week or 1 month."
    ),
  defaultGroupId: z.number().int().min(1).max(MAX_INT4),
});
