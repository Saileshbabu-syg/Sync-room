ALTER TABLE "employee" RENAME TO "Employee";--> statement-breakpoint
ALTER TABLE "room" RENAME TO "rooms";--> statement-breakpoint
ALTER TABLE "Employee" DROP CONSTRAINT "employee_email_unique";--> statement-breakpoint
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_room_id_room_room_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting_attendees" DROP CONSTRAINT "meeting_attendees_employee_id_employee_employee_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_employee_id_Employee_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_email_unique" UNIQUE("email");