/**
 * Single source of truth for the database schema (Drizzle ORM + PostgreSQL).
 *
 * Layout (ordered by dependency so every FK target is declared before use):
 *   1. Lookup / master tables
 *   2. Identity tables (employee, organizer, auth)
 *   3. Core domain tables (rooms, meeting and its children)
 *   4. Relations (for `db.query.*` relational queries)
 *   5. Inferred row types
 *
 * NOTE: table names, column names and exported identifiers are deliberately
 * unchanged from the previous per-file schema so the existing database and all
 * call sites keep working. Apply changes with `npx drizzle-kit generate` then `npx drizzle-kit migrate`.
 *
 * Not expressible in Drizzle (so it lives only in migration 0020 — apply
 * schema changes with `migrate`, never `push`): the `meeting_no_room_overlap`
 * EXCLUDE constraint that stops two non-cancelled meetings from overlapping in
 * the same room, and the `meeting_end_after_start` check.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* 1. Lookup / master tables                                                  */
/* -------------------------------------------------------------------------- */

export const roles = pgTable(
  "roles",
  {
    roleId: serial("role_id").primaryKey(),
    roleName: varchar("role_name", { length: 50 }).notNull().unique(),
    // Priority tier. A meeting whose organizer or attendees include a role with
    // a higher boost outranks every meeting with a lower boost, whatever the
    // meeting type (see lib/priority-rank). 0 = no boost; Manager = 1.
    priorityBoost: integer("priority_boost").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    check("roles_priority_boost_range", sql`${t.priorityBoost} BETWEEN 0 AND 4`),
  ]
);

export const availabilityMaster = pgTable("availability_master", {
  availabilityStatusId: serial("availability_status_id").primaryKey(),
  availabilityStatusCode: varchar("availability_status_code", {
    length: 30,
  }).unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const meetingTypes = pgTable(
  "meeting_types",
  {
    meetingTypeId: serial("meeting_type_id").primaryKey(),
    meetingTypeName: varchar("meeting_type_name", { length: 50 })
      .notNull()
      .unique(),
    // Lower number = higher priority (1 Client, 2 Interview, 3 Team meeting,
    // 4 Training / One-on-one, 5 Others). A meeting may only bump a strictly
    // higher rank number; equal ranks never bump each other.
    priorityRank: integer("priority_rank").notNull().default(5),
  },
  (t) => [
    check("meeting_types_priority_rank_range", sql`${t.priorityRank} BETWEEN 1 AND 5`),
  ]
);

// Which meeting types each role may book. Drives the type list shown to a
// user after login and is re-checked server-side on booking and edit.
export const roleMeetingTypes = pgTable(
  "role_meeting_types",
  {
    roleMeetingTypeId: serial("role_meeting_type_id").primaryKey(),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.roleId),
    meetingTypeId: integer("meeting_type_id")
      .notNull()
      .references(() => meetingTypes.meetingTypeId),
  },
  (t) => [
    unique().on(t.roleId, t.meetingTypeId),
    index("role_meeting_types_meeting_type_id_idx").on(t.meetingTypeId),
  ]
);

export const meetingStatuses = pgTable("meeting_statuses", {
  meetingStatusId: serial("meeting_status_id").primaryKey(),
  meetingStatusName: varchar("meeting_status_name", { length: 30 }).unique(),
});

export const notification_type_master = pgTable("notification_type_master", {
  notification_type_id: serial("notification_type_id").primaryKey(),
  notification_type_name: varchar("notification_type_name", { length: 30 })
    .unique()
    .notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

export const recurrence_frequency_master = pgTable(
  "recurrence_frequency_master",
  {
    frequency_id: serial("frequency_id").primaryKey(),
    frequency_name: varchar("frequency_name", { length: 20 })
      .unique()
      .notNull(),
    created_at: timestamp("created_at").defaultNow(),
  }
);

/* -------------------------------------------------------------------------- */
/* 2. Identity tables                                                         */
/* -------------------------------------------------------------------------- */

export const employee = pgTable(
  "Employee",
  {
    employee_id: serial("employee_id").primaryKey(),
    role_id: integer("role_id")
      .notNull()
      .references(() => roles.roleId),
    employee_name: varchar("employee_name", { length: 100 }).notNull(),
    // Login key: sign-in matches on it, so it must always be present.
    email: varchar("email", { length: 150 }).notNull().unique(),
    // Microsoft Entra ID object id. The stable key for directory sync; null
    // for people added by hand and not yet matched to a directory account.
    entra_object_id: uuid("entra_object_id").unique(),
    // False once the person has left: they can no longer sign in or act as an
    // organizer. Set by the Entra sync (people missing from, or disabled in,
    // the directory) and reversed by it if they come back. Rows are never
    // deleted: bookings and history refer to them.
    is_active: boolean("is_active").notNull().default(true),
    deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("employee_role_id_idx").on(t.role_id),
    // Sign-in and session lookups compare e-mails case-insensitively.
    index("employee_email_lower_idx").on(sql`lower(${t.email})`),
  ]
);

// One row per Entra ID sync attempt, so the screen can show progress, the last
// success and the last error. Rows are only ever appended or finished.
export const employeeSyncRuns = pgTable(
  "employee_sync_runs",
  {
    id: serial("id").primaryKey(),
    status: varchar("status", { length: 16 }).notNull().default("RUNNING"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    triggeredBy: integer("triggered_by").references(() => employee.employee_id),
    fetched: integer("fetched").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    linked: integer("linked").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    deactivated: integer("deactivated").notNull().default(0),
    // Why people missing from the directory were NOT deactivated on this run
    // (empty directory, over the safety threshold), if that happened.
    deactivation_note: text("deactivation_note"),
    error: text("error"),
  },
  (t) => [
    index("employee_sync_runs_started_idx").on(t.startedAt),
    check(
      "employee_sync_runs_status_valid",
      sql`${t.status} IN ('RUNNING', 'SUCCESS', 'FAILED')`
    ),
    // At most one sync can be running at a time.
    uniqueIndex("employee_sync_runs_one_running_idx")
      .on(t.status)
      .where(sql`${t.status} = 'RUNNING'`),
  ]
);

export const organizers = pgTable(
  "Organizer",
  {
    organizerId: serial("organizer_id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employee.employee_id),
    name: varchar("name", { length: 100 }).notNull(),
    email: varchar("email", { length: 150 }).notNull().unique(),
    imageUrl: text("image_url"),
    role: varchar("role", { length: 50 }).notNull(),
    password: varchar("password", { length: 255 }),
    provider: varchar("provider", { length: 50 }).default("google"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("organizer_employee_id_idx").on(t.employeeId),
    index("organizer_email_lower_idx").on(sql`lower(${t.email})`),
  ]
);

export const accounts = pgTable(
  "Account",
  {
    accountId: serial("account_id").primaryKey(),
    organizerId: integer("organizer_id")
      .notNull()
      .references(() => organizers.organizerId, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 })
      .notNull()
      .unique(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("account_organizer_id_idx").on(t.organizerId)]
);

export const sessions = pgTable(
  "Session",
  {
    sessionId: serial("session_id").primaryKey(),
    organizerId: integer("organizer_id")
      .notNull()
      .references(() => organizers.organizerId, { onDelete: "cascade" }),
    sessionToken: text("session_token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [index("session_organizer_id_idx").on(t.organizerId)]
);

/* -------------------------------------------------------------------------- */
/* 3. Core domain tables                                                      */
/* -------------------------------------------------------------------------- */

export const room = pgTable(
  "rooms",
  {
    room_id: serial("room_id").primaryKey(),
    room_name: varchar("room_name", { length: 100 }).notNull(),
    room_capacity: integer("room_capacity").notNull(),
    roomLocation: varchar("room_location", { length: 100 }),
    facilities: varchar("facilities", { length: 255 }),
    availabilityStatusId: integer("availability_status_id").references(
      () => availabilityMaster.availabilityStatusId
    ),
    roomDescription: varchar("room_description", { length: 255 }),
    imageUrl: varchar("image_url", { length: 255 }),
    // Set when the room is archived: it can no longer be booked or offered,
    // but stays in the database for the meetings that were held in it.
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("rooms_availability_status_id_idx").on(t.availabilityStatusId),
    check("rooms_capacity_positive", sql`${t.room_capacity} >= 1`),
  ]
);

// Parent of a series of `meeting` rows (one per occurrence). Declared before
// `meeting` because `meeting.recurring_meeting_id` references it.
export const recurring_meetings = pgTable(
  "recurring_meetings",
  {
    recurring_meeting_id: serial("recurring_meeting_id").primaryKey(),
    frequency_id: integer("frequency_id")
      .notNull()
      .references(() => recurrence_frequency_master.frequency_id),
    occurrence_count: integer("occurrence_count").notNull(),
    // Date of the last booked occurrence (kept up to date when the series is
    // shortened or extended).
    recurrence_end_date: date("recurrence_end_date"),
    // The pattern the occurrences come from: its first date (the grid every
    // later date is computed from), "every N weeks" for WEEKLY (1 otherwise),
    // and the end-by date the organizer chose, if any. Null pattern_start_date
    // = a series booked before the pattern was stored: its first booked date
    // is used instead.
    pattern_start_date: date("pattern_start_date"),
    recurrence_interval: integer("recurrence_interval").notNull().default(1),
    until_date: date("until_date"),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("recurring_meetings_frequency_id_idx").on(t.frequency_id),
    check(
      "recurring_meetings_occurrence_count_positive",
      sql`${t.occurrence_count} >= 1`
    ),
    check(
      "recurring_meetings_interval_range",
      sql`${t.recurrence_interval} BETWEEN 1 AND 12`
    ),
  ]
);

// Dates of a series' pattern that are deliberately NOT booked (left out at
// booking time). Kept so that extending or regenerating the series never
// re-creates them, and so the e-mails can list them exactly.
export const recurringMeetingSkippedDates = pgTable(
  "recurring_meeting_skipped_dates",
  {
    id: serial("id").primaryKey(),
    recurringMeetingId: integer("recurring_meeting_id")
      .notNull()
      .references(() => recurring_meetings.recurring_meeting_id, {
        onDelete: "cascade",
      }),
    skippedDate: date("skipped_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("recurring_meeting_skipped_dates_uq").on(
      t.recurringMeetingId,
      t.skippedDate
    ),
  ]
);

// Application groups. They live only in this database (never in Entra / Azure):
// each carries a booking priority (1 = highest) and a set of permission keys.
// Admin is NOT a group - it stays a role (see ROLE_ADMIN).
export const groups = pgTable(
  "groups",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    // 1 = highest priority. Groups may share a priority.
    priority: integer("priority").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("groups_name_lower_uq").on(sql`lower(${t.name})`),
    check("groups_priority_range", sql`${t.priority} BETWEEN 1 AND 1000`),
    check("groups_name_not_blank", sql`length(btrim(${t.name})) > 0`),
  ]
);

// Group membership with history. An employee has at most ONE row with
// effective_until IS NULL (partial unique index) - the active assignment.
// Changing group closes that row and opens a new one.
export const userGroups = pgTable(
  "user_groups",
  {
    id: serial("id").primaryKey(),
    // The application's stable employee key (Employee.employee_id).
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employee.employee_id),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "restrict" }),
    assignedBy: integer("assigned_by").references(() => employee.employee_id),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("user_groups_one_active_per_employee_idx")
      .on(t.employeeId)
      .where(sql`${t.effectiveUntil} IS NULL`),
    index("user_groups_group_id_idx").on(t.groupId),
    check(
      "user_groups_until_after_assigned",
      sql`${t.effectiveUntil} IS NULL OR ${t.effectiveUntil} >= ${t.assignedAt}`
    ),
  ]
);

// Which meeting types each group may book (replaces the per-role list for
// anyone who has a group; people without one keep using role_meeting_types).
export const groupMeetingTypes = pgTable(
  "group_meeting_types",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    meetingTypeId: integer("meeting_type_id")
      .notNull()
      .references(() => meetingTypes.meetingTypeId),
  },
  (t) => [
    unique("group_meeting_types_group_type_uq").on(t.groupId, t.meetingTypeId),
    index("group_meeting_types_type_idx").on(t.meetingTypeId),
  ]
);

// Per-group booking limits. A null column means "no extra limit" (the system
// maximum still applies); limits can only tighten the system ones.
//
// Booking policies (see lib/booking-limits.ts for how they are resolved with
// the application-wide ones in app_booking_settings):
//  * overnight_policy is an explicit choice, so "inherit" is its own value:
//    INHERIT (follow the application), ALLOWED or NOT_ALLOWED;
//  * every numeric limit uses null for "no limit of this group's own" - the
//    application's limit, if any, still applies (the stricter one wins).
export const groupSettings = pgTable(
  "group_settings",
  {
    groupId: integer("group_id")
      .primaryKey()
      .references(() => groups.id, { onDelete: "cascade" }),
    maxDurationMinutes: integer("max_duration_minutes"),
    maxAdvanceDays: integer("max_advance_days"),
    maxOccurrences: integer("max_occurrences"),
    overnightPolicy: varchar("overnight_policy", { length: 12 })
      .notNull()
      .default("INHERIT"),
    maxBookingsPerDay: integer("max_bookings_per_day"),
    maxBookingsPerWeek: integer("max_bookings_per_week"),
    maxBookingsPerMonth: integer("max_bookings_per_month"),
  },
  (t) => [
    check(
      "group_settings_overnight_valid",
      sql`${t.overnightPolicy} IN ('INHERIT', 'ALLOWED', 'NOT_ALLOWED')`
    ),
    check(
      "group_settings_per_day_range",
      sql`${t.maxBookingsPerDay} IS NULL OR ${t.maxBookingsPerDay} BETWEEN 1 AND 1000`
    ),
    check(
      "group_settings_per_week_range",
      sql`${t.maxBookingsPerWeek} IS NULL OR ${t.maxBookingsPerWeek} BETWEEN 1 AND 5000`
    ),
    check(
      "group_settings_per_month_range",
      sql`${t.maxBookingsPerMonth} IS NULL OR ${t.maxBookingsPerMonth} BETWEEN 1 AND 20000`
    ),
    check(
      "group_settings_duration_range",
      sql`${t.maxDurationMinutes} IS NULL OR ${t.maxDurationMinutes} BETWEEN 15 AND 1440`
    ),
    check(
      "group_settings_advance_range",
      sql`${t.maxAdvanceDays} IS NULL OR ${t.maxAdvanceDays} BETWEEN 1 AND 92`
    ),
    check(
      "group_settings_occurrences_range",
      sql`${t.maxOccurrences} IS NULL OR ${t.maxOccurrences} BETWEEN 1 AND 12`
    ),
  ]
);

// Rooms a group may book. A group with NO rows here may book every room; with
// rows, only those.
export const groupRooms = pgTable(
  "group_rooms",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    roomId: integer("room_id")
      .notNull()
      .references(() => room.room_id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("group_rooms_group_room_uq").on(t.groupId, t.roomId),
    index("group_rooms_room_idx").on(t.roomId),
  ]
);

// Application-wide booking policies (a single row, id = 1; no row = the
// defaults below, which keep the behaviour from before these settings existed).
// They are the upper boundary for every group's own settings: the effective
// rule for a group is always the stricter of the two. Null = unlimited.
export const appBookingSettings = pgTable(
  "app_booking_settings",
  {
    id: integer("id").primaryKey().default(1),
    // Master switch for meetings that continue past midnight.
    allowOvernight: boolean("allow_overnight").notNull().default(false),
    // The longest meeting anywhere, in minutes.
    maxDurationMinutes: integer("max_duration_minutes"),
    // Bookings one GROUP may hold per calendar day / week (Mon-Sun) / month.
    maxBookingsPerDay: integer("max_bookings_per_day"),
    maxBookingsPerWeek: integer("max_bookings_per_week"),
    maxBookingsPerMonth: integer("max_bookings_per_month"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: integer("updated_by").references(() => employee.employee_id),
  },
  (t) => [
    check("app_booking_settings_single_row", sql`${t.id} = 1`),
    check(
      "app_booking_settings_duration_range",
      sql`${t.maxDurationMinutes} IS NULL OR ${t.maxDurationMinutes} BETWEEN 15 AND 1440`
    ),
    check(
      "app_booking_settings_per_day_range",
      sql`${t.maxBookingsPerDay} IS NULL OR ${t.maxBookingsPerDay} BETWEEN 1 AND 1000`
    ),
    check(
      "app_booking_settings_per_week_range",
      sql`${t.maxBookingsPerWeek} IS NULL OR ${t.maxBookingsPerWeek} BETWEEN 1 AND 5000`
    ),
    check(
      "app_booking_settings_per_month_range",
      sql`${t.maxBookingsPerMonth} IS NULL OR ${t.maxBookingsPerMonth} BETWEEN 1 AND 20000`
    ),
  ]
);

// Entra ID sync settings (a single row, id = 1).
export const entraSyncSettings = pgTable(
  "entra_sync_settings",
  {
    id: integer("id").primaryKey().default(1),
    autoSyncEnabled: boolean("auto_sync_enabled").notNull().default(false),
    intervalHours: integer("interval_hours").notNull().default(24),
    // Where people with no group land after a sync; null = the Employee group.
    defaultGroupId: integer("default_group_id").references(() => groups.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: integer("updated_by").references(() => employee.employee_id),
  },
  (t) => [
    check("entra_sync_settings_single_row", sql`${t.id} = 1`),
    check(
      "entra_sync_settings_interval_range",
      sql`${t.intervalHours} IN (1, 24, 168, 720)`
    ),
  ]
);

export const groupPermissions = pgTable(
  "group_permissions",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    permissionKey: varchar("permission_key", { length: 64 }).notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
  (t) => [
    unique("group_permissions_group_key_uq").on(t.groupId, t.permissionKey),
  ]
);

export const meeting = pgTable(
  "meeting",
  {
    meeting_id: serial("meeting_id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    room_id: integer("room_id")
      .notNull()
      .references(() => room.room_id),
    meeting_date: date("meeting_date").notNull(),
    organizerEmployeeId: integer("organizer_employee_id")
      .notNull()
      .references(() => employee.employee_id),
    participantCount: integer("participant_count").notNull(),
    meetingTypeId: integer("meeting_type_id")
      .notNull()
      .references(() => meetingTypes.meetingTypeId),
    meetingStatusId: integer("meeting_status_id")
      .notNull()
      .references(() => meetingStatuses.meetingStatusId),
    start_time: time("start_time").notNull(),
    end_time: time("end_time").notNull(),
    // Set when this occurrence belongs to a recurring series; null for
    // one-off meetings.
    recurringMeetingId: integer("recurring_meeting_id").references(
      () => recurring_meetings.recurring_meeting_id
    ),
    // Snapshot of the organizer's application group when the meeting was
    // booked. Later group or priority changes never rewrite it. Null on
    // meetings that pre-date groups (they rank as the default policy).
    groupIdAtBooking: integer("group_id_at_booking").references(
      () => groups.id,
      { onDelete: "restrict" }
    ),
    priorityAtBooking: integer("priority_at_booking"),
    // Version of this meeting's calendar entry (iCalendar SEQUENCE). Raised in
    // the same transaction as a change that moves or renames the entry (date,
    // time, room, title), so every invite sent afterwards supersedes the
    // earlier ones; a cancellation goes out as this + 1 (calendar.service).
    ics_sequence: integer("ics_sequence").notNull().default(0),
    // Online (Microsoft Teams) meeting. Every occurrence of a series has its
    // own event and link. `is_online` is true only while a valid join URL and
    // event id are stored (see the consistency check below);
    // `online_requested` records that the organizer asked for Teams, so a
    // failed creation can be retried.
    online_requested: boolean("online_requested").notNull().default(false),
    is_online: boolean("is_online").notNull().default(false),
    online_provider: varchar("online_provider", { length: 40 }),
    online_join_url: text("online_join_url"),
    online_event_id: varchar("online_event_id", { length: 255 }),
    // Teams provisioning, done by the background worker (online-meeting.service):
    //   NONE    - no online meeting asked for;
    //   PENDING - the Teams event must be created or brought up to date;
    //   READY   - the event matches the meeting (link stored);
    //   FAILED  - automatic retries are used up; a person can retry.
    // `online_version` rises whenever the event must change (booking, move,
    // rename, retry); a worker only marks READY if it is still the version it
    // worked on, so stale work never overwrites a newer change.
    online_status: varchar("online_status", { length: 10 }).notNull().default("NONE"),
    online_version: integer("online_version").notNull().default(0),
    online_attempts: integer("online_attempts").notNull().default(0),
    online_next_attempt_at: timestamp("online_next_attempt_at", { withTimezone: true }),
    online_locked_until: timestamp("online_locked_until", { withTimezone: true }),
    online_last_error: text("online_last_error"),
    online_synced_at: timestamp("online_synced_at", { withTimezone: true }),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    check(
      "meeting_online_status_valid",
      sql`${t.online_status} IN ('NONE', 'PENDING', 'READY', 'FAILED')`
    ),
    // The worker's queue: due PENDING rows.
    index("meeting_online_pending_idx")
      .on(t.online_status, t.online_next_attempt_at)
      .where(sql`${t.online_status} = 'PENDING'`),
    check(
      "meeting_online_consistent",
      sql`NOT ${t.is_online} OR (${t.online_join_url} IS NOT NULL AND ${t.online_event_id} IS NOT NULL AND ${t.online_provider} IS NOT NULL)`
    ),
    // One Teams event belongs to exactly one meeting (duplicate guard).
    uniqueIndex("meeting_online_event_id_uq")
      .on(t.online_event_id)
      .where(sql`${t.online_event_id} IS NOT NULL`),
    // Hot path: conflict checks and availability lookups filter by room + date.
    index("meeting_room_date_idx").on(t.room_id, t.meeting_date),
    // The group booking limits count a group's meetings per day/week/month.
    index("meeting_group_date_idx").on(t.groupIdAtBooking, t.meeting_date),
    index("meeting_organizer_employee_id_idx").on(t.organizerEmployeeId),
    index("meeting_status_id_idx").on(t.meetingStatusId),
    index("meeting_type_id_idx").on(t.meetingTypeId),
    index("meeting_recurring_meeting_id_idx").on(t.recurringMeetingId),
    check("meeting_participant_count_positive", sql`${t.participantCount} >= 1`),
    check("meeting_ics_sequence_nonneg", sql`${t.ics_sequence} >= 0`),
  ]
);

export const meeting_attendees = pgTable(
  "meeting_attendees",
  {
    meeting_attendee_id: serial("meeting_attendee_id").primaryKey(),
    meeting_id: integer("meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    employee_id: integer("employee_id")
      .notNull()
      .references(() => employee.employee_id),
    // The participant's answer to the e-mail invitation. The organizer is
    // ACCEPTED from the start; everyone else begins as NO_RESPONSE and can
    // answer once (see invitation.service).
    response_status: varchar("response_status", { length: 15 })
      .notNull()
      .default("NO_RESPONSE"),
    responded_at: timestamp("responded_at", { withTimezone: true }),
    // Invited but not essential. An optional participant's answer never
    // affects the booking.
    is_optional: boolean("is_optional").notNull().default(false),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    unique().on(t.meeting_id, t.employee_id),
    index("meeting_attendees_employee_id_idx").on(t.employee_id),
    check(
      "meeting_attendees_response_valid",
      sql`${t.response_status} IN ('NO_RESPONSE', 'ACCEPTED', 'DECLINED')`
    ),
  ]
);

export const notifications = pgTable(
  "notifications",
  {
    notification_id: serial("notification_id").primaryKey(),
    meeting_id: integer("meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    notification_type_id: integer("notification_type_id")
      .notNull()
      .references(() => notification_type_master.notification_type_id),
    status: varchar("status", { length: 20 }).default("PENDING"),
    // Set for a per-person message (an invitation): only that employee is
    // mailed. Null = the usual message to every attendee.
    recipient_employee_id: integer("recipient_employee_id").references(
      () => employee.employee_id
    ),
    // Delivery attempts so far, counted when a worker CLAIMS the row (so a
    // worker that keeps crashing mid-send still uses up attempts). PENDING rows
    // are retried until the limit, then parked as FAILED.
    attempts: integer("attempts").notNull().default(0),
    // PENDING rows are not picked up before this (exponential backoff).
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // While SENDING: the claiming worker's lease. Past it, another worker may
    // take the row over (the first one is presumed dead).
    locked_until: timestamp("locked_until", { withTimezone: true }),
    // Why the last attempt failed or why the row was skipped; addresses are
    // never stored here (lib/delivery-policy.ts).
    last_error: text("last_error"),
    sent_at: timestamp("sent_at"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("notifications_meeting_id_idx").on(t.meeting_id),
    index("notifications_type_id_idx").on(t.notification_type_id),
    index("notifications_status_next_idx").on(t.status, t.next_attempt_at),
    check(
      "notifications_status_valid",
      sql`${t.status} IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')`
    ),
    check("notifications_attempts_nonneg", sql`${t.attempts} >= 0`),
  ]
);

export const reminder_logs = pgTable(
  "reminder_logs",
  {
    reminder_log_id: serial("reminder_log_id").primaryKey(),
    meeting_id: integer("meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    reminder_time: timestamp("reminder_time", { withTimezone: true }).notNull(),
    // PENDING (due at reminder_time) -> SENDING (claimed) -> SENT | SKIPPED |
    // FAILED; a failed attempt goes back to PENDING until the limit.
    status: varchar("status", { length: 20 }).default("PENDING"),
    // Same meaning as on `notifications`.
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    locked_until: timestamp("locked_until", { withTimezone: true }),
    last_error: text("last_error"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("reminder_logs_meeting_id_idx").on(t.meeting_id),
    // One reminder per meeting, so retries / double submits cannot duplicate it.
    uniqueIndex("reminder_logs_meeting_id_uq").on(t.meeting_id),
    index("reminder_logs_status_time_idx").on(t.status, t.reminder_time),
    check(
      "reminder_logs_status_valid",
      sql`${t.status} IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED')`
    ),
    check("reminder_logs_attempts_nonneg", sql`${t.attempts} >= 0`),
  ]
);

export const meeting_audit_logs = pgTable(
  "meeting_audit_logs",
  {
    audit_log_id: serial("audit_log_id").primaryKey(),
    meeting_id: integer("meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    action: varchar("action", { length: 100 }).notNull(),
    remarks: varchar("remarks", { length: 255 }),
    // Who triggered the event; null for system actions (cron).
    actor_employee_id: integer("actor_employee_id").references(
      () => employee.employee_id
    ),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [index("meeting_audit_logs_meeting_id_idx").on(t.meeting_id)]
);

// A higher-priority meeting (the claimant) asking for the slot held by a
// lower-priority one (the bumped meeting). The bumped meeting keeps its slot
// until the organizer reschedules/cancels or `deadline` passes, at which point
// the cron job auto-reallocates it. status: PENDING | RESCHEDULED | CANCELLED |
// AUTO_REALLOCATED | AUTO_CANCELLED | WITHDRAWN.
export const reschedule_requests = pgTable(
  "reschedule_requests",
  {
    reschedule_request_id: serial("reschedule_request_id").primaryKey(),
    bumped_meeting_id: integer("bumped_meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    claimant_meeting_id: integer("claimant_meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    // One claim per slot: a meeting can have at most one pending request.
    uniqueIndex("reschedule_requests_one_pending_per_bumped_idx")
      .on(t.bumped_meeting_id)
      .where(sql`${t.status} = 'PENDING'`),
    index("reschedule_requests_claimant_idx").on(t.claimant_meeting_id),
    // Cron scan: pending requests ordered by deadline.
    index("reschedule_requests_status_deadline_idx").on(t.status, t.deadline),
    check(
      "reschedule_requests_status_valid",
      sql`${t.status} IN ('PENDING', 'RESCHEDULED', 'CANCELLED', 'AUTO_REALLOCATED', 'AUTO_CANCELLED', 'WITHDRAWN')`
    ),
    check(
      "reschedule_requests_distinct_meetings",
      sql`${t.bumped_meeting_id} <> ${t.claimant_meeting_id}`
    ),
  ]
);

// An employee asks the organizer of a booked meeting (the holder) for its room.
// The request is NOT a booking: nothing is booked until the slot is actually
// free. status:
//   PENDING        waiting for the organizer
//   AWAITING_SLOT  the organizer agreed, but the original booking still holds
//                  the room; it is booked as soon as the room is free
//   APPROVED       the requested meeting was booked (resulting_meeting_id)
//   REJECTED       the organizer said no (rejection_reason)
//   CANCELLED      the requester took it back
//   EXPIRED        the requested slot started before it was completed
//   FAILED         agreed and the room was free, but booking was refused
//                  (e.g. room out of service)
export const room_requests = pgTable(
  "room_requests",
  {
    room_request_id: serial("room_request_id").primaryKey(),
    // The exact meeting row in the way (a recurring series has one row per
    // occurrence, so this is the single occurrence, not the series).
    holder_meeting_id: integer("holder_meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    holder_organizer_employee_id: integer("holder_organizer_employee_id")
      .notNull()
      .references(() => employee.employee_id),
    requester_employee_id: integer("requester_employee_id")
      .notNull()
      .references(() => employee.employee_id),
    room_id: integer("room_id")
      .notNull()
      .references(() => room.room_id),
    meeting_date: date("meeting_date").notNull(),
    start_time: time("start_time").notNull(),
    end_time: time("end_time").notNull(),
    // Details of the meeting to book once approved.
    title: varchar("title", { length: 200 }).notNull(),
    participant_count: integer("participant_count").notNull(),
    meeting_type_id: integer("meeting_type_id")
      .notNull()
      .references(() => meetingTypes.meetingTypeId),
    participant_employee_ids: integer("participant_employee_ids")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    // The requester's own words, kept exactly as sent (trimmed).
    message: text("message").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    rejection_reason: varchar("rejection_reason", { length: 500 }),
    // Set when the organizer agreed (also for AWAITING_SLOT).
    organizer_approved_at: timestamp("organizer_approved_at", {
      withTimezone: true,
    }),
    // Final decision: who and when (approve/reject/cancel/expiry).
    decided_by_employee_id: integer("decided_by_employee_id").references(
      () => employee.employee_id
    ),
    responded_at: timestamp("responded_at", { withTimezone: true }),
    // The meeting booked when the request was completed.
    resulting_meeting_id: integer("resulting_meeting_id").references(
      () => meeting.meeting_id
    ),
    // Sent by the browser with each submit, so a double click or a network
    // retry returns the same request instead of creating another.
    client_request_id: varchar("client_request_id", { length: 64 }),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    // A person has at most one open request per booked meeting.
    uniqueIndex("room_requests_one_open_per_requester_idx")
      .on(t.holder_meeting_id, t.requester_employee_id)
      .where(sql`${t.status} IN ('PENDING', 'AWAITING_SLOT')`),
    uniqueIndex("room_requests_client_request_id_uq")
      .on(t.requester_employee_id, t.client_request_id)
      .where(sql`${t.client_request_id} IS NOT NULL`),
    index("room_requests_holder_idx").on(t.holder_meeting_id),
    index("room_requests_holder_organizer_idx").on(t.holder_organizer_employee_id),
    index("room_requests_requester_idx").on(t.requester_employee_id),
    // Expiry / fulfilment scans: open requests by the date they are for.
    index("room_requests_status_date_idx").on(t.status, t.meeting_date),
    check(
      "room_requests_status_valid",
      sql`${t.status} IN ('PENDING', 'AWAITING_SLOT', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED')`
    ),
    check("room_requests_end_after_start", sql`${t.end_time} > ${t.start_time}`),
    check("room_requests_participant_count_positive", sql`${t.participant_count} >= 1`),
    check(
      "room_requests_message_length",
      sql`char_length(btrim(${t.message})) BETWEEN 1 AND 1000`
    ),
  ]
);

// One row per booked meeting that is in the way of a request. Every one of
// them must agree before the room is booked, so each organizer decides on
// their own meeting(s). (room_requests.holder_* is the earliest of them.)
// status: PENDING | APPROVED | REJECTED
export const room_request_holders = pgTable(
  "room_request_holders",
  {
    room_request_holder_id: serial("room_request_holder_id").primaryKey(),
    room_request_id: integer("room_request_id")
      .notNull()
      .references(() => room_requests.room_request_id, { onDelete: "cascade" }),
    holder_meeting_id: integer("holder_meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    organizer_employee_id: integer("organizer_employee_id")
      .notNull()
      .references(() => employee.employee_id),
    status: varchar("status", { length: 10 }).notNull().default("PENDING"),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    unique("room_request_holders_request_meeting_uq").on(
      t.room_request_id,
      t.holder_meeting_id
    ),
    index("room_request_holders_organizer_idx").on(t.organizer_employee_id),
    index("room_request_holders_meeting_idx").on(t.holder_meeting_id),
    check(
      "room_request_holders_status_valid",
      sql`${t.status} IN ('PENDING', 'APPROVED', 'REJECTED')`
    ),
  ]
);

// E-mail outbox for room requests. One row per (request, kind): the unique
// constraint is what stops a retry or a double click from mailing twice. The
// recipient and the text are worked out when the mail is sent, from the
// database - never from anything the client supplied.
export const room_request_emails = pgTable(
  "room_request_emails",
  {
    room_request_email_id: serial("room_request_email_id").primaryKey(),
    room_request_id: integer("room_request_id")
      .notNull()
      .references(() => room_requests.room_request_id, { onDelete: "cascade" }),
    // SUBMITTED | AWAITING_RELEASE | APPROVAL_PENDING | APPROVED | REJECTED |
    // CANCELLED | EXPIRED | FAILED
    kind: varchar("kind", { length: 30 }).notNull(),
    // Who it is for. A request can concern several organizers, so one kind is
    // mailed once per recipient.
    recipient_employee_id: integer("recipient_employee_id")
      .notNull()
      .references(() => employee.employee_id),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    // Short, safe reason for the last failure (never credentials).
    last_error: varchar("last_error", { length: 200 }),
    sent_at: timestamp("sent_at"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    unique("room_request_emails_request_kind_recipient_uq").on(
      t.room_request_id,
      t.kind,
      t.recipient_employee_id
    ),
    index("room_request_emails_status_idx").on(t.status),
    check(
      "room_request_emails_status_valid",
      sql`${t.status} IN ('PENDING', 'SENT', 'FAILED')`
    ),
  ]
);

// One row per booking taken over by a higher-priority one. Append-only: a
// trigger (migration 0027) rejects UPDATE and DELETE.
export const bookingPriorityHistory = pgTable(
  "booking_priority_history",
  {
    id: serial("id").primaryKey(),
    incomingBookingId: integer("incoming_booking_id")
      .notNull()
      .references(() => meeting.meeting_id),
    affectedBookingId: integer("affected_booking_id")
      .notNull()
      .references(() => meeting.meeting_id),
    previousGroupId: integer("previous_group_id").references(() => groups.id),
    previousPriority: integer("previous_priority").notNull(),
    incomingGroupId: integer("incoming_group_id").references(() => groups.id),
    incomingPriority: integer("incoming_priority").notNull(),
    reason: varchar("reason", { length: 255 }).notNull(),
    // Who triggered it (the incoming booking's organizer).
    actorEmployeeId: integer("actor_employee_id").references(
      () => employee.employee_id
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("booking_priority_history_affected_idx").on(t.affectedBookingId),
    index("booking_priority_history_incoming_idx").on(t.incomingBookingId),
  ]
);

// Admin changes to groups, priorities, permissions and memberships, Entra
// settings, and dashboard report exports (REPORT_EXPORTED).
// Append-only (trigger in migration 0027).
export const groupAuditLogs = pgTable(
  "group_audit_logs",
  {
    id: serial("id").primaryKey(),
    actorEmployeeId: integer("actor_employee_id").references(
      () => employee.employee_id
    ),
    action: varchar("action", { length: 64 }).notNull(),
    // Deliberately no FK: the row must survive the group's deletion, and the
    // table is append-only (an ON DELETE SET NULL update would be rejected).
    groupId: integer("group_id"),
    targetEmployeeId: integer("target_employee_id").references(
      () => employee.employee_id
    ),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("group_audit_logs_created_idx").on(t.createdAt)]
);

/* -------------------------------------------------------------------------- */
/* 4. Relations                                                             */
/* -------------------------------------------------------------------------- */

export const rolesRelations = relations(roles, ({ many }) => ({
  employees: many(employee),
  allowedMeetingTypes: many(roleMeetingTypes),
}));

export const meetingTypesRelations = relations(meetingTypes, ({ many }) => ({
  allowedRoles: many(roleMeetingTypes),
}));

export const roleMeetingTypesRelations = relations(
  roleMeetingTypes,
  ({ one }) => ({
    role: one(roles, {
      fields: [roleMeetingTypes.roleId],
      references: [roles.roleId],
    }),
    meetingType: one(meetingTypes, {
      fields: [roleMeetingTypes.meetingTypeId],
      references: [meetingTypes.meetingTypeId],
    }),
  })
);

export const rescheduleRequestsRelations = relations(
  reschedule_requests,
  ({ one }) => ({
    bumpedMeeting: one(meeting, {
      fields: [reschedule_requests.bumped_meeting_id],
      references: [meeting.meeting_id],
      relationName: "bumpedMeeting",
    }),
    claimantMeeting: one(meeting, {
      fields: [reschedule_requests.claimant_meeting_id],
      references: [meeting.meeting_id],
      relationName: "claimantMeeting",
    }),
  })
);

export const roomRequestsRelations = relations(room_requests, ({ one }) => ({
  holderMeeting: one(meeting, {
    fields: [room_requests.holder_meeting_id],
    references: [meeting.meeting_id],
    relationName: "roomRequestHolder",
  }),
  resultingMeeting: one(meeting, {
    fields: [room_requests.resulting_meeting_id],
    references: [meeting.meeting_id],
    relationName: "roomRequestResult",
  }),
  requester: one(employee, {
    fields: [room_requests.requester_employee_id],
    references: [employee.employee_id],
  }),
  room: one(room, {
    fields: [room_requests.room_id],
    references: [room.room_id],
  }),
}));

export const employeeRelations = relations(employee, ({ one, many }) => ({
  role: one(roles, {
    fields: [employee.role_id],
    references: [roles.roleId],
  }),
  organizers: many(organizers),
  organizedMeetings: many(meeting),
  attendances: many(meeting_attendees),
}));

export const organizersRelations = relations(organizers, ({ one, many }) => ({
  employee: one(employee, {
    fields: [organizers.employeeId],
    references: [employee.employee_id],
  }),
  accounts: many(accounts),
  sessions: many(sessions),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  organizer: one(organizers, {
    fields: [accounts.organizerId],
    references: [organizers.organizerId],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  organizer: one(organizers, {
    fields: [sessions.organizerId],
    references: [organizers.organizerId],
  }),
}));

export const roomRelations = relations(room, ({ one, many }) => ({
  availability: one(availabilityMaster, {
    fields: [room.availabilityStatusId],
    references: [availabilityMaster.availabilityStatusId],
  }),
  meetings: many(meeting),
}));

export const meetingRelations = relations(meeting, ({ one, many }) => ({
  room: one(room, {
    fields: [meeting.room_id],
    references: [room.room_id],
  }),
  organizer: one(employee, {
    fields: [meeting.organizerEmployeeId],
    references: [employee.employee_id],
  }),
  type: one(meetingTypes, {
    fields: [meeting.meetingTypeId],
    references: [meetingTypes.meetingTypeId],
  }),
  status: one(meetingStatuses, {
    fields: [meeting.meetingStatusId],
    references: [meetingStatuses.meetingStatusId],
  }),
  attendees: many(meeting_attendees),
  recurringMeeting: one(recurring_meetings, {
    fields: [meeting.recurringMeetingId],
    references: [recurring_meetings.recurring_meeting_id],
  }),
  notifications: many(notifications),
  reminderLogs: many(reminder_logs),
  auditLogs: many(meeting_audit_logs),
  bumpRequests: many(reschedule_requests, { relationName: "bumpedMeeting" }),
  claimRequests: many(reschedule_requests, { relationName: "claimantMeeting" }),
  roomRequests: many(room_requests, { relationName: "roomRequestHolder" }),
}));

export const meetingAttendeesRelations = relations(
  meeting_attendees,
  ({ one }) => ({
    meeting: one(meeting, {
      fields: [meeting_attendees.meeting_id],
      references: [meeting.meeting_id],
    }),
    employee: one(employee, {
      fields: [meeting_attendees.employee_id],
      references: [employee.employee_id],
    }),
  })
);

export const recurringMeetingsRelations = relations(
  recurring_meetings,
  ({ one, many }) => ({
    occurrences: many(meeting),
    frequency: one(recurrence_frequency_master, {
      fields: [recurring_meetings.frequency_id],
      references: [recurrence_frequency_master.frequency_id],
    }),
  })
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  meeting: one(meeting, {
    fields: [notifications.meeting_id],
    references: [meeting.meeting_id],
  }),
  type: one(notification_type_master, {
    fields: [notifications.notification_type_id],
    references: [notification_type_master.notification_type_id],
  }),
}));

export const reminderLogsRelations = relations(reminder_logs, ({ one }) => ({
  meeting: one(meeting, {
    fields: [reminder_logs.meeting_id],
    references: [meeting.meeting_id],
  }),
}));

export const meetingAuditLogsRelations = relations(
  meeting_audit_logs,
  ({ one }) => ({
    meeting: one(meeting, {
      fields: [meeting_audit_logs.meeting_id],
      references: [meeting.meeting_id],
    }),
  })
);

/* -------------------------------------------------------------------------- */
/* 5. Inferred row types                                                      */
/* -------------------------------------------------------------------------- */

export type Role = typeof roles.$inferSelect;
export type Employee = typeof employee.$inferSelect;
export type NewEmployee = typeof employee.$inferInsert;
export type Organizer = typeof organizers.$inferSelect;
export type NewOrganizer = typeof organizers.$inferInsert;
export type Room = typeof room.$inferSelect;
export type NewRoom = typeof room.$inferInsert;
export type Meeting = typeof meeting.$inferSelect;
export type NewMeeting = typeof meeting.$inferInsert;
export type MeetingAttendee = typeof meeting_attendees.$inferSelect;
export type NewMeetingAttendee = typeof meeting_attendees.$inferInsert;
export type RecurringMeeting = typeof recurring_meetings.$inferSelect;
export type NewRecurringMeeting = typeof recurring_meetings.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type ReminderLog = typeof reminder_logs.$inferSelect;
export type MeetingAuditLog = typeof meeting_audit_logs.$inferSelect;
export type MeetingType = typeof meetingTypes.$inferSelect;
export type RoleMeetingType = typeof roleMeetingTypes.$inferSelect;
export type RescheduleRequest = typeof reschedule_requests.$inferSelect;
export type NewRescheduleRequest = typeof reschedule_requests.$inferInsert;
export type RoomRequest = typeof room_requests.$inferSelect;
export type NewRoomRequest = typeof room_requests.$inferInsert;
export type RoomRequestEmail = typeof room_request_emails.$inferSelect;
export type RoomRequestHolder = typeof room_request_holders.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type UserGroup = typeof userGroups.$inferSelect;
export type GroupSettings = typeof groupSettings.$inferSelect;
export type GroupMeetingType = typeof groupMeetingTypes.$inferSelect;
export type EmployeeSyncRun = typeof employeeSyncRuns.$inferSelect;
export type GroupPermission = typeof groupPermissions.$inferSelect;
export type BookingPriorityHistory = typeof bookingPriorityHistory.$inferSelect;
export type GroupAuditLog = typeof groupAuditLogs.$inferSelect;
