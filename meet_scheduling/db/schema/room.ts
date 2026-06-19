import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

import { availabilityMaster } from "./availabilityMaster";

export const room = pgTable("room", {
  roomId: uuid("room_id").primaryKey(),

  roomName: varchar("room_name", {
    length: 100,
  }),

  roomCapacity: integer("room_capacity"),

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

  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});