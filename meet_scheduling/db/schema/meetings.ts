import {
  pgTable,
  serial,
  varchar,
  integer,
  date,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { employee } from "./employee";
import { room } from "./room";
import { meetingTypes } from "./meetingTypes";
import { meetingStatuses } from "./meetingStatuses";

export const meetings = pgTable("meetings", {
  meetingId: serial("meeting_id").primaryKey(),

  title: varchar("title", { length: 200 }).notNull(),

  meetingDate: date("meeting_date").notNull(),

  organizerEmployeeId: integer("organizer_employee_id")
    .notNull()
    .references(() => employee.employeeId),

  roomId: integer("room_id")
    .notNull()
    .references(() => room.roomId),

  participantCount: integer("participant_count").notNull(),

  meetingTypeId: integer("meeting_type_id")
    .notNull()
    .references(() => meetingTypes.meetingTypeId),

  meetingStatusId: integer("meeting_status_id")
    .notNull()
    .references(() => meetingStatuses.meetingStatusId),

  startTime: time("start_time").notNull(),

  endTime: time("end_time").notNull(),

  createdAt: timestamp("created_at").defaultNow(),

  updatedAt: timestamp("updated_at").defaultNow(),
});