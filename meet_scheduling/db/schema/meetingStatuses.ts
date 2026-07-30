import { pgTable, serial, varchar } from "drizzle-orm/pg-core";

export const meetingStatuses = pgTable("meeting_statuses", {
  meetingStatusId: serial("meeting_status_id").primaryKey(),

  meetingStatusName: varchar("meeting_status_name", {
    length: 30,
  }).unique(),
});