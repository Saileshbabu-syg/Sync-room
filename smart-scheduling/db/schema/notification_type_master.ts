import { pgTable, serial, varchar, timestamp } from "drizzle-orm/pg-core";
export const notification_type_master = pgTable(
  "notification_type_master",
  {
    notification_type_id: serial("notification_type_id").primaryKey(),
    notification_type_name: varchar("notification_type_name", {
      length: 30,
    })
      .unique()
      .notNull(),
    created_at: timestamp("created_at").defaultNow(),
  }
);
