import {
  pgTable,
  serial,
  uuid,
  varchar,
  text,
  timestamp,
  bigint,
  integer,
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
   USERS
========================= */

export const users = pgTable("users", {
  userId: uuid("user_id").defaultRandom().primaryKey(),

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
  accountId: uuid("account_id").defaultRandom().primaryKey(),

  userId: uuid("user_id")
    .notNull()
    .references(() => users.userId, {
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
  sessionId: uuid("session_id").defaultRandom().primaryKey(),

  userId: uuid("user_id")
    .notNull()
    .references(() => users.userId, {
      onDelete: "cascade",
    }),

  sessionToken: text("session_token")
    .notNull()
    .unique(),

  expiresAt: timestamp("expires_at").notNull(),

  createdAt: timestamp("created_at").defaultNow(),
});

export const employees = pgTable("employees", {
  employeeId: uuid("employee_id").defaultRandom().primaryKey(),

  userId: uuid("user_id")
    .notNull()
    .references(() => users.userId),

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

  createdAt: timestamp("created_at")
    .defaultNow()
    .notNull(),

  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull(),
});