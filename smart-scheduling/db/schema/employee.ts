import {
  pgTable,
  integer,
  serial,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

import { roles } from "./roles";

export const employee = pgTable("Employee", {
  employee_id: serial("employee_id").primaryKey(),

  role_id: integer("role_id").notNull().references(() => roles.roleId),

  employee_name: varchar("employee_name", {
    length: 100,
  }).notNull(),

  email: varchar("email", {
    length: 150,
  }).unique(),

  created_at: timestamp("created_at").defaultNow(),

  updated_at: timestamp("updated_at").defaultNow(),
});
