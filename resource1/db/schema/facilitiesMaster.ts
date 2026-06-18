import {
  pgTable,
  serial,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

export const facilitiesMaster = pgTable("facilities_master", {
  facilityId: serial("facility_id").primaryKey(),

  facilityName: varchar("facility_name", {
    length: 50,
  }).notNull().unique(),

  facilityDescription: varchar(
    "facility_description",
    {
      length: 100,
    }
  ),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});