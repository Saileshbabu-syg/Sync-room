import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

import { meeting } from "./meeting";

export const reminder_logs = pgTable(
  "reminder_logs",
  {
    reminder_log_id: serial("reminder_log_id").primaryKey(),

    meeting_id: integer("meeting_id").references(() => meeting.meeting_id).notNull(),

    reminder_time: timestamp("reminder_time", {withTimezone:true,}).notNull(),

    status: varchar("status", {
      length: 20,
    }).default("SENT"),

    created_at: timestamp("created_at").defaultNow(),
  }
);
