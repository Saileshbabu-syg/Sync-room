// Lookup-table ids and domain constants shared by routes and services.
//
// The ids mirror the rows created by `db/seed-lookups.ts`; the application has
// always relied on them, they are just named here instead of repeated as magic
// numbers.

export const MEETING_STATUS = {
  SCHEDULED: 1,
  COMPLETED: 2,
  CANCELLED: 3,
  // A meeting whose room was taken by a higher-priority one. It waits for its
  // organizer to pick another room or time and is cancelled automatically
  // BUMP_RESPONSE_CUTOFF_MINUTES before it starts. It does not hold its slot.
  PENDING_RESCHEDULE: 4,
} as const;

// Statuses whose meeting no longer occupies its room slot.
export const SLOT_FREE_STATUSES: number[] = [
  MEETING_STATUS.CANCELLED,
  MEETING_STATUS.PENDING_RESCHEDULE,
];

// A bumped meeting that is still pending this long before it starts is
// cancelled.
export const BUMP_RESPONSE_CUTOFF_MINUTES = 30;

// Display names for MEETING_STATUS ids. The UI derives the label from the id,
// so it does not depend on how the status names are cased in the database.
export const MEETING_STATUS_LABEL: Record<number, string> = {
  [MEETING_STATUS.SCHEDULED]: "Scheduled",
  [MEETING_STATUS.COMPLETED]: "Completed",
  [MEETING_STATUS.CANCELLED]: "Cancelled",
  [MEETING_STATUS.PENDING_RESCHEDULE]: "Pending reschedule",
};

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
  // Seeded by db/seed-priority.ts: sent when a higher-priority booking takes
  // over the slot of a lower-priority meeting.
  BUMPED: "BUMP_REQUEST",
} as const;
