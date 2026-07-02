import { pgTable, serial, varchar } from "drizzle-orm/pg-core";

export const meetingTypes = pgTable("meeting_types", {
  meetingTypeId: serial("meeting_type_id").primaryKey(),

  meetingTypeName: varchar("meeting_type_name", {
    length: 50,
  })
    .notNull()
    .unique(),
});