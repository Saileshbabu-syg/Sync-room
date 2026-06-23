import {
  pgTable,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

import { meetings } from "./meetings";
import { employee } from "./employee";

export const meetingAttendees = pgTable("meeting_attendees", {
  meetingAttendeeId: serial("meeting_attendee_id").primaryKey(),

  meetingId: integer("meeting_id")
    .references(() => meetings.meetingId),

  employeeId: integer("employee_id")
    .references(() => employee.employeeId),

  createdAt: timestamp("created_at").defaultNow(),
});