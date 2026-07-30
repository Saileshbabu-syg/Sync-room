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

export const accounts = pgTable("Account", {
  accountId: serial("account_id").primaryKey(),

  organizerId: integer("organizer_id")
    .notNull()
    .references(() => organizers.organizerId, {
      onDelete: "cascade",
    }),

  provider: varchar("provider", {
    length: 50,
  }).notNull(),

  providerAccountId: varchar("provider_account_id", {
    length: 255,
  })
    .notNull()
    .unique(),

  accessToken: text("access_token"),

  refreshToken: text("refresh_token"),

  expiresAt: bigint("expires_at", {
    mode: "number",
  }),

  createdAt: timestamp("created_at").defaultNow(),
});