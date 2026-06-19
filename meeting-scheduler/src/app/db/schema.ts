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

export const roles = pgTable("roles", {
  roleId: serial("role_id").primaryKey(),

  roleName: varchar("role_name", {
    length: 50,
  })
    .notNull()
    .unique(),

  createdAt: timestamp("created_at").defaultNow(),
});

/* =========================
   EMPLOYEES
========================= */

export const employees = pgTable("employees", {
  employeeId: uuid("employee_id")
    .defaultRandom()
    .primaryKey(),

  roleId: integer("role_id")
    .notNull()
    .references(() => roles.roleId),

  employeeName: varchar("employee_name", {
    length: 100,
  }).notNull(),

  email: varchar("email", {
    length: 150,
  })
    .notNull()
    .unique(),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});

/* =========================
   ORGANIZERS
========================= */

export const organizers = pgTable("organizers", {
  organizerId: serial("organizer_id").primaryKey(),

  employeeId: uuid("employee_id").references(
    () => employees.employeeId
  ),

  name: varchar("name", {
    length: 100,
  }).notNull(),

  email: varchar("email", {
    length: 150,
  })
    .notNull()
    .unique(),

  imageUrl: text("image_url"),

  roleId: integer("role_id")
    .notNull()
    .references(() => roles.roleId),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});

/* =========================
   ACCOUNTS
========================= */

export const accounts = pgTable("accounts", {
  accountId: serial("account_id").primaryKey(),

  organizerId: integer("organizer_id")
    .notNull()
    .references(() => organizers.organizerId, {
      onDelete: "cascade",
    }),

  provider: varchar("provider", {
    length: 50,
  }).notNull(),

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

export const sessions = pgTable("sessions", {
  sessionId: serial("session_id").primaryKey(),

  organizerId: integer("organizer_id")
    .notNull()
    .references(() => organizers.organizerId, {
      onDelete: "cascade",
    }),

  sessionToken: text("session_token")
    .notNull()
    .unique(),

  expiresAt: timestamp("expires_at").notNull(),

  createdAt: timestamp("created_at").defaultNow(),
});