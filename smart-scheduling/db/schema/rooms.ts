import {
  pgTable,
  serial,
  varchar,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

import { availabilityMaster } from "./availabilityMaster";

export const room = pgTable("rooms", {
  room_id: serial("room_id").primaryKey(),

  room_name: varchar("room_name", { length: 100 }).notNull(),

  room_capacity: integer("room_capacity").notNull(),

  roomLocation: varchar("room_location", {
    length: 100,
  }),

  facilities: varchar("facilities", {
    length: 255,
  }),

  availabilityStatusId: integer("availability_status_id")
    .references(() => availabilityMaster.availabilityStatusId),

  roomDescription: varchar("room_description", {
    length: 255,
  }),

  created_at: timestamp("created_at").defaultNow(),

  updated_at: timestamp("updated_at").defaultNow(),
});
