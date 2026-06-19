import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";

import { roles } from "./roles";

export const employee = pgTable("employee", {
  employeeId: uuid("employee_id").primaryKey(),
  roleId: integer("role_id")
    .notNull()
    .references(() => roles.roleId),

  employeeName: varchar("employee_name", {
    length: 100,
  }).notNull(),

  email: varchar("email", {
    length: 150,
  }).notNull().unique(),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});