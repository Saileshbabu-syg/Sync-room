import {
  pgTable,
  serial,
  varchar,
  date,
  time,
  timestamp,
} from "drizzle-orm/pg-core";

export const meeting = pgTable("meeting", {
  meeting_id: serial("meeting_id").primaryKey(),

  title: varchar("title", { length: 200 }).notNull(),

  meeting_date: date("meeting_date").notNull(),

  start_time: time("start_time").notNull(),

  end_time: time("end_time").notNull(),

  created_at: timestamp("created_at").defaultNow(),

  updated_at: timestamp("updated_at").defaultNow(),
});
