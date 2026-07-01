import {
  pgTable,
  serial,
  integer,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";


import { meeting } from "./meeting";
import { employee } from "./Employee";

export const meeting_attendees = pgTable(
  "meeting_attendees",
  {
    meeting_attendee_id: serial("meeting_attendee_id").primaryKey(),

    meeting_id: integer("meeting_id")
      .references(() => meeting.meeting_id)
      .notNull(),

    employee_id: integer("employee_id")
      .references(() => employee.employee_id)
      .notNull(),

    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    unique_meeting_employee: unique().on(
      table.meeting_id,
      table.employee_id
    ),
  })
);
