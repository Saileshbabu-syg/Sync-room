import {
  pgTable,
  serial,
  integer,
  varchar,
  date,
  time,
  timestamp,
} from "drizzle-orm/pg-core";

import { room } from "./rooms";

export const meeting = pgTable("meeting", {
  meeting_id: serial("meeting_id").primaryKey(),

  title: varchar("title", { length: 200 }).notNull(),

  room_id: integer("room_id")
    .references(() => room.room_id)
    .notNull(),

  meeting_date: date("meeting_date").notNull(),

  start_time: time("start_time").notNull(),

  end_time: time("end_time").notNull(),

  created_at: timestamp("created_at").defaultNow(),

  updated_at: timestamp("updated_at").defaultNow(),
});
