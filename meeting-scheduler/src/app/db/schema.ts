import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
} from "drizzle-orm/pg-core";

/* =========================
   EMPLOYEE
========================= */

export const employees = pgTable("Employee", {
  employeeId: serial("employee_id").primaryKey(),

  employeeName: varchar("employee_name", {
    length: 100,
  }).notNull(),

  email: varchar("email", {
    length: 150,
  })
    .notNull()
    .unique(),

  role: varchar("role", {
    length: 50,
  }).notNull(),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});

/* =========================
   ORGANIZER
========================= */

export const organizers = pgTable("Organizer", {
  organizerId: serial("organizer_id").primaryKey(),

  employeeId: integer("employee_id").references(
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

  role: varchar("role", {
    length: 50,
  }).notNull(),

  password: varchar("password", {
    length: 255,
  }),

  provider: varchar("provider", {
    length: 50,
  }).default("google"),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});

/* =========================
   ACCOUNT
========================= */

export const accounts = pgTable("Account", {
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
   SESSION
========================= */

export const sessions = pgTable("Session", {
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