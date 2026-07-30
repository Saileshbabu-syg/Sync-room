import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
} from "drizzle-orm/pg-core";

import { organizers } from "./organizer";

export const sessions = pgTable("Session", {
  sessionId: serial("session_id").primaryKey(),

  organizerId: integer("organizer_id")
    .notNull()
    .references(() => organizers.organizerId, {
      onDelete: "cascade",
    }),

  sessionToken: text("session_token")
    .notNull()
    .unique(),

  expiresAt: timestamp("expires_at").notNull(),

  createdAt: timestamp("created_at").defaultNow(),
});