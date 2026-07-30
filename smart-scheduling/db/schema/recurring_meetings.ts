import {
  pgTable,
  serial,
  integer,
  date,
  timestamp,
} from "drizzle-orm/pg-core";

import { meeting } from "./meeting";
import { recurrence_frequency_master } from "./recurrence_frequency_master";

export const recurring_meetings = pgTable(
  "recurring_meetings",
  {
    recurring_meeting_id: serial("recurring_meeting_id").primaryKey(),

    meeting_id: integer("meeting_id").references(() => meeting.meeting_id).notNull(),

    frequency_id: integer("frequency_id").references(() => recurrence_frequency_master.frequency_id).notNull(),

    occurrence_count: integer("occurrence_count").notNull(),

    recurrence_end_date: date("recurrence_end_date"),

    created_at: timestamp("created_at").defaultNow(),

    updated_at: timestamp("updated_at").defaultNow(),
  }
);
