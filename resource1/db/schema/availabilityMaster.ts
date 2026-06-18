import {
  pgTable,
  serial,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

export const availabilityMaster = pgTable("availability_master", {
  availabilityStatusId: serial("availability_status_id").primaryKey(),

  availabilityStatusCode: varchar("availability_status_code", {
    length: 30,
  }).notNull().unique(),

  availabilityStatusDescription: varchar(
    "availability_status_description",
    {
      length: 100,
    }
  ),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});