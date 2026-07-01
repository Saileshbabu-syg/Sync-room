import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

import { meeting } from "./meeting";
import { notification_type_master } from "./notification_type_master";

export const notifications = pgTable(
  "notifications",
  {
    notification_id: serial("notification_id").primaryKey(),

    meeting_id: integer("meeting_id").references(() => meeting.meeting_id).notNull(),

    notification_type_id: integer("notification_type_id").references(() => notification_type_master.notification_type_id).notNull(),

    status: varchar("status", {length: 20,}).default("PENDING"),

    sent_at: timestamp("sent_at"),

    created_at: timestamp("created_at").defaultNow(),
  }
);
