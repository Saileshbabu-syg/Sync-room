import {
  pgTable,
  serial,
  varchar,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const room = pgTable("room", {
  room_id: serial("room_id").primaryKey(),

  room_name: varchar("room_name", { length: 100 }).notNull(),

  room_capacity: integer("room_capacity").notNull(),

  created_at: timestamp("created_at").defaultNow(),

  updated_at: timestamp("updated_at").defaultNow(),
});
