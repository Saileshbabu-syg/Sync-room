import {
  pgTable,
  serial,
  integer,
  date,
  time,
  timestamp,
} from "drizzle-orm/pg-core";

import { rooms } from "./rooms";

export const meetings = pgTable("meetings", {
  meetingId: serial("meeting_id").primaryKey(),

  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.roomId),

  meetingDate: date("meeting_date").notNull(),

  startTime: time("start_time").notNull(),

  endTime: time("end_time").notNull(),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});