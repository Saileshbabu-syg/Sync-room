import {
  pgTable,
  serial,
  uuid,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

import { rooms } from "./rooms";
import { facilitiesMaster } from "./facilitiesMaster";

export const roomFacilities = pgTable("room_facilities", {
  roomFacilityId: serial("room_facility_id").primaryKey(),

  roomId: uuid("room_id")
    .references(() => rooms.roomId)
    .notNull(),

  facilityId: integer("facility_id")
    .references(() => facilitiesMaster.facilityId)
    .notNull(),

  createdAt: timestamp("created_at")
    .defaultNow()
    .notNull(),
});