import { pgTable, serial, varchar, timestamp } from "drizzle-orm/pg-core";

export const recurrence_frequency_master = pgTable(
  "recurrence_frequency_master",
  {
    frequency_id: serial("frequency_id").primaryKey(),
    frequency_name: varchar("frequency_name", { length: 20 })
      .unique()
      .notNull(),
    created_at: timestamp("created_at").defaultNow(),
  }
);
