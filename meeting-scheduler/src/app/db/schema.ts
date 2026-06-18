import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  uuid,
} from "drizzle-orm/pg-core";

/* =========================
   ROLES
========================= */
export const roles = pgTable("Roles", {
  roleId: serial("role_id").primaryKey(),

  roleName: varchar("role_name", { length: 50 })
    .notNull()
    .unique(),

  createdAt: timestamp("created_at").defaultNow(),
});

/* =========================
   EMPLOYEE
========================= */
export const employees = pgTable("Employee", {
  employeeId: uuid("employee_id")
    .defaultRandom()
    .primaryKey(),

  roleId: integer("role_id")
    .notNull()
    .references(() => roles.roleId),

  employeeName: varchar("employee_name", { length: 100 })
    .notNull(),

  email: varchar("email", { length: 150 })
    .notNull()
    .unique(),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});

/* =========================
   ORGANIZER
========================= */
export const organizers = pgTable("Organizer", {
  organizerId: serial("organizer_id").primaryKey(),

  employeeId: integer("employee_id"),

  name: varchar("name", { length: 100 }).notNull(),

  email: varchar("email", { length: 150 })
    .notNull()
    .unique(),

  imageUrl: text("image_url"),

  roleId: integer("role_id")
    .references(() => roles.roleId),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});

/* =========================
   ACCOUNTS
========================= */
export const accounts = pgTable("Accounts", {
  accountId: serial("account_id").primaryKey(),

  organizerId: integer("organizer_id")
    .references(() => organizers.organizerId),

  provider: varchar("provider", { length: 50 })
    .notNull(),

  providerAccountId: varchar("provider_account_id", {
    length: 255,
  })
    .notNull()
    .unique(),

  accessToken: text("access_token"),

  refreshToken: text("refresh_token"),

  expiresAt: bigint("expires_at", {
    mode: "number",
  }),

  createdAt: timestamp("created_at").defaultNow(),
});

/* =========================
   SESSIONS
========================= */
export const sessions = pgTable("Sessions", {
  sessionId: serial("session_id").primaryKey(),

  organizerId: integer("organizer_id")
    .references(() => organizers.organizerId),

  sessionToken: text("session_token")
    .notNull()
    .unique(),

  expiresAt: timestamp("expires_at")
    .notNull(),

  createdAt: timestamp("created_at").defaultNow(),
});