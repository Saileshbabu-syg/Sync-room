import {
  pgTable,
  serial,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

export const employee = pgTable("Employee", {
  employee_id: serial("employee_id").primaryKey(),

  employee_name: varchar("employee_name", {
    length: 100,
  }).notNull(),

  email: varchar("email", {
    length: 150,
  }).unique(),

  created_at: timestamp("created_at").defaultNow(),

  updated_at: timestamp("updated_at").defaultNow(),
});
