import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
} from "drizzle-orm/pg-core";

import { employee } from "./employee";

export const organizers = pgTable("Organizer", {
  organizerId: serial("organizer_id").primaryKey(),

  employeeId: integer("employee_id")
  .references(() => employee.employee_id)
  .notNull(),

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