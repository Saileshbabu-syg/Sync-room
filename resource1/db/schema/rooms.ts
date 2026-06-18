import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

import { availabilityMaster } from "./availabilityMaster";

export const rooms = pgTable("rooms", {
  roomId: uuid("room_id")
    .defaultRandom()
    .primaryKey(),

  roomName: varchar("room_name", {
    length: 100,
  }).notNull(),

  roomCapacity: integer("room_capacity")
    .notNull(),

  availabilityStatusId: integer("availability_status_id")
    .references(() => availabilityMaster.availabilityStatusId)
    .notNull(),

  roomLocation: varchar("room_location", {
    length: 100,
  }),

  roomDescription: varchar("room_description", {
    length: 255,
  }),

  createdAt: timestamp("created_at")
    .defaultNow()
    .notNull(),

  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull(),
});