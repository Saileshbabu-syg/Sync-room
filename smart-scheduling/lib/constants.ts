// Lookup-table ids and domain constants shared by routes and services.
//
// The ids mirror the rows created by `db/seed-lookups.ts`; the application has
// always relied on them, they are just named here instead of repeated as magic
// numbers.

export const MEETING_STATUS = {
  SCHEDULED: 1,
  COMPLETED: 2,
  CANCELLED: 3,
} as const;

export const AVAILABILITY_STATUS = {
  AVAILABLE: 1,
} as const;

export const ROLE_ADMIN = "Admin";

// Meetings are stored as wall-clock date + time; this is the zone those values
// are interpreted in (the reminder cron has always used it too).
export const APP_TIMEZONE = "Asia/Kolkata";

// Largest value a Postgres `integer` column accepts.
export const MAX_INT4 = 2147483647;

// Reminder is sent this long before a meeting starts.
export const REMINDER_LEAD_MINUTES = Number(
  process.env.REMINDER_LEAD_MINUTES ?? 15
);

// Notification / reminder delivery is attempted this many times before the
// row is parked as FAILED.
export const MAX_DELIVERY_ATTEMPTS = 3;

export const NOTIFICATION_TYPE = {
  BOOKED: "MEETING_BOOKED",
  UPDATED: "MEETING_UPDATED",
  CANCELLED: "MEETING_CANCELLED",
} as const;
