import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

import { meeting } from "./meeting";

export const meeting_audit_logs = pgTable(
  "meeting_audit_logs",
  {
    audit_log_id: serial("audit_log_id")
      .primaryKey(),

    meeting_id: integer("meeting_id")
      .references(() => meeting.meeting_id)
      .notNull(),

    action: varchar("action", {
      length: 100,
    }).notNull(),

    remarks: varchar("remarks", {
      length: 255,
    }),

    created_at: timestamp("created_at")
      .defaultNow(),
  }
);