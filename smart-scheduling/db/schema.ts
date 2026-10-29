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
  check,
  date,
  index,
  integer,
  pgTable,
  serial,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* 1. Lookup / master tables                                                  */
/* -------------------------------------------------------------------------- */

export const roles = pgTable("roles", {
  roleId: serial("role_id").primaryKey(),
  roleName: varchar("role_name", { length: 50 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

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
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [index("employee_role_id_idx").on(t.role_id)]
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
  (t) => [index("organizer_employee_id_idx").on(t.employeeId)]
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
    recurrence_end_date: date("recurrence_end_date"),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("recurring_meetings_frequency_id_idx").on(t.frequency_id),
    check(
      "recurring_meetings_occurrence_count_positive",
      sql`${t.occurrence_count} >= 1`
    ),
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
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    // Hot path: conflict checks and availability lookups filter by room + date.
    index("meeting_room_date_idx").on(t.room_id, t.meeting_date),
    index("meeting_organizer_employee_id_idx").on(t.organizerEmployeeId),
    index("meeting_status_id_idx").on(t.meetingStatusId),
    index("meeting_type_id_idx").on(t.meetingTypeId),
    index("meeting_recurring_meeting_id_idx").on(t.recurringMeetingId),
    check("meeting_participant_count_positive", sql`${t.participantCount} >= 1`),
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
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    unique().on(t.meeting_id, t.employee_id),
    index("meeting_attendees_employee_id_idx").on(t.employee_id),
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
    // Delivery attempts so far; PENDING rows are retried until the limit,
    // then parked as FAILED.
    attempts: integer("attempts").notNull().default(0),
    sent_at: timestamp("sent_at"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("notifications_meeting_id_idx").on(t.meeting_id),
    index("notifications_type_id_idx").on(t.notification_type_id),
    check(
      "notifications_status_valid",
      sql`${t.status} IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')`
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
    // PENDING (due at reminder_time) -> SENT | SKIPPED | FAILED
    status: varchar("status", { length: 20 }).default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("reminder_logs_meeting_id_idx").on(t.meeting_id),
    // One reminder per meeting, so retries / double submits cannot duplicate it.
    uniqueIndex("reminder_logs_meeting_id_uq").on(t.meeting_id),
    index("reminder_logs_status_time_idx").on(t.status, t.reminder_time),
    check(
      "reminder_logs_status_valid",
      sql`${t.status} IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')`
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
