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
 * call sites keep working. Apply changes with `npx drizzle-kit push`.
 */
import { relations } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  serial,
  text,
  time,
  timestamp,
  unique,
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
  createdAt: timestamp("created_at"),
});

export const meetingTypes = pgTable("meeting_types", {
  meetingTypeId: serial("meeting_type_id").primaryKey(),
  meetingTypeName: varchar("meeting_type_name", { length: 50 })
    .notNull()
    .unique(),
});

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
    email: varchar("email", { length: 150 }).unique(),
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
  (t) => [index("rooms_availability_status_id_idx").on(t.availabilityStatusId)]
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
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    // Hot path: conflict checks and availability lookups filter by room + date.
    index("meeting_room_date_idx").on(t.room_id, t.meeting_date),
    index("meeting_organizer_employee_id_idx").on(t.organizerEmployeeId),
    index("meeting_status_id_idx").on(t.meetingStatusId),
    index("meeting_type_id_idx").on(t.meetingTypeId),
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

export const recurring_meetings = pgTable(
  "recurring_meetings",
  {
    recurring_meeting_id: serial("recurring_meeting_id").primaryKey(),
    meeting_id: integer("meeting_id")
      .notNull()
      .references(() => meeting.meeting_id),
    frequency_id: integer("frequency_id")
      .notNull()
      .references(() => recurrence_frequency_master.frequency_id),
    occurrence_count: integer("occurrence_count").notNull(),
    recurrence_end_date: date("recurrence_end_date"),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("recurring_meetings_meeting_id_idx").on(t.meeting_id),
    index("recurring_meetings_frequency_id_idx").on(t.frequency_id),
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
    sent_at: timestamp("sent_at"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("notifications_meeting_id_idx").on(t.meeting_id),
    index("notifications_type_id_idx").on(t.notification_type_id),
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
    status: varchar("status", { length: 20 }).default("SENT"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [index("reminder_logs_meeting_id_idx").on(t.meeting_id)]
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
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => [index("meeting_audit_logs_meeting_id_idx").on(t.meeting_id)]
);

/* -------------------------------------------------------------------------- */
/* 4. Relations                                                               */
/* -------------------------------------------------------------------------- */

export const rolesRelations = relations(roles, ({ many }) => ({
  employees: many(employee),
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
  recurrences: many(recurring_meetings),
  notifications: many(notifications),
  reminderLogs: many(reminder_logs),
  auditLogs: many(meeting_audit_logs),
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
  ({ one }) => ({
    meeting: one(meeting, {
      fields: [recurring_meetings.meeting_id],
      references: [meeting.meeting_id],
    }),
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
export type Notification = typeof notifications.$inferSelect;
export type ReminderLog = typeof reminder_logs.$inferSelect;
export type MeetingAuditLog = typeof meeting_audit_logs.$inferSelect;
