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
  // A confirmed meeting taken over by a booking from a higher-priority group.
  // Terminal: it does not hold its slot and is not rescheduled automatically.
  // (Id 5 is taken by a PENDING_ROOM row on the shared database.)
  PREEMPTED: 6,
} as const;

// Statuses whose meeting no longer occupies its room slot.
export const SLOT_FREE_STATUSES: number[] = [
  MEETING_STATUS.CANCELLED,
  MEETING_STATUS.PENDING_RESCHEDULE,
  MEETING_STATUS.PREEMPTED,
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
  // Stored as PREEMPTED (the engine's term); people see "Replaced".
  [MEETING_STATUS.PREEMPTED]: "Replaced",
};

export const AVAILABILITY_STATUS = {
  AVAILABLE: 1,
} as const;

export const ROLE_ADMIN = "Admin";

// How a participant was invited, shown instead of the stored is_optional flag:
// people from the Participants field vs the Optional Participants field.
export const INVITATION_CATEGORY = {
  PRIMARY: "Primary Invitee",
  ADDITIONAL: "Additional Invitee",
} as const;

export const invitationCategory = (isOptional: boolean) =>
  isOptional ? INVITATION_CATEGORY.ADDITIONAL : INVITATION_CATEGORY.PRIMARY;

// Permission keys a group can grant (see group_permissions). Enforced on the
// backend by lib/permissions.ts - never by group name.
export const PERMISSION = {
  DASHBOARD_VIEW: "dashboard.view",
  // The Group Management module: groups, their permissions and meeting types,
  // employee assignments and the Entra ID sync.
  GROUP_MANAGE: "group.manage",
  BOOKING_CREATE: "booking.create",
  BOOKING_VIEW: "booking.view",
  BOOKING_CANCEL: "booking.cancel",
  // Legacy, no effect: priority now comes from the meeting type (and the
  // outranks / protected permissions below). Still accepted so the rows already
  // stored for each group stay valid; it is no longer offered in Group Management.
  BOOKING_PRIORITY: "booking.priority",
  // May book recurring series.
  BOOKING_RECURRING: "booking.recurring",
  // May create, edit and delete rooms (the Admin role always may).
  ROOMS_MANAGE: "rooms.manage",
  // A meeting with any member of this group invited (required or optional)
  // outranks every meeting type, so it always gets the room. Leadership has it
  // by default; Group Management can give it to any other group.
  BOOKING_OUTRANKS: "booking.outranks",
  // A meeting with any member of this group invited (required or optional)
  // can never be taken over, by any meeting. Independent of booking.outranks:
  // Leadership has both by default.
  BOOKING_PROTECTED: "booking.protected",
} as const;

export type PermissionKey = (typeof PERMISSION)[keyof typeof PERMISSION];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSION);

// Permissions that reach beyond a person's own bookings. A group granting any
// of them is "privileged": only someone with the Admin role may edit it, grant
// these permissions, or move people into or out of it (group.service.ts).
export const PRIVILEGED_PERMISSIONS: PermissionKey[] = [
  PERMISSION.GROUP_MANAGE,
  PERMISSION.ROOMS_MANAGE,
  PERMISSION.DASHBOARD_VIEW,
  PERMISSION.BOOKING_OUTRANKS,
  PERMISSION.BOOKING_PROTECTED,
];

// Policy for an employee with no active group: they can book, see and cancel
// their own bookings, rank as the LOWEST active group, may not preempt anyone
// and get no dashboard access. Never the highest priority.
export const DEFAULT_PERMISSIONS: PermissionKey[] = [
  PERMISSION.BOOKING_CREATE,
  PERMISSION.BOOKING_VIEW,
  PERMISSION.BOOKING_CANCEL,
  PERMISSION.BOOKING_RECURRING,
];

// Priority used when no active group exists at all.
export const FALLBACK_PRIORITY = 1000;

// Where people with no group are placed by the directory sync, and the role
// given to people created by it.
export const DEFAULT_GROUP_NAME = "Employee";

// Booking rank of a meeting that includes a member of a group with the
// booking.outranks permission: above every meeting type (types are ranked
// 1 = highest ... 5 = lowest).
export const TOP_RANK = 0;

// Rank of a HELD meeting that includes a member of a group with
// booking.protected: below TOP_RANK, so no booking can ever take its room.
export const PROTECTED_RANK = -1;
export const DEFAULT_ROLE_NAME = "Employee";

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
// row is parked as FAILED (fewer for a permanent failure: see
// lib/delivery-policy.ts). Retries back off exponentially.
export const MAX_DELIVERY_ATTEMPTS = 5;

export const NOTIFICATION_TYPE = {
  BOOKED: "MEETING_BOOKED",
  UPDATED: "MEETING_UPDATED",
  CANCELLED: "MEETING_CANCELLED",
  // Seeded by db/seed-priority.ts: sent when a higher-priority booking takes
  // over the slot of a lower-priority meeting.
  BUMPED: "BUMP_REQUEST",
  // Created on demand: sent to every attendee of a meeting preempted by a
  // higher-priority group's booking.
  PREEMPTED: "MEETING_PREEMPTED",
  // Created on demand: one per invited participant, with Accept / Decline links.
  INVITED: "MEETING_INVITED",
} as const;
