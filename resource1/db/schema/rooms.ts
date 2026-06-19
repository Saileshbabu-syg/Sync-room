import {
  pgTable,
  serial,
  varchar,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

import { availabilityMaster } from "./availabilityMaster";

export const rooms = pgTable("rooms", {
  roomId: serial("room_id").primaryKey(),
  roomName: varchar("room_name", {
    length: 100,
  }).notNull(),

  roomCapacity: integer("room_capacity")
    .notNull(),

  roomLocation: varchar("room_location", {
    length: 100,
  }),

  facilities: varchar("facilities", {
    length: 255,
  }),

  availabilityStatusId: integer(
    "availability_status_id"
  )
    .references(
      () => availabilityMaster.availabilityStatusId
    )
    .notNull(),

  roomDescription: varchar(
    "room_description",
    {
      length: 255,
    }
  ),

  createdAt: timestamp("created_at")
    .defaultNow()
    .notNull(),

  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull(),
});