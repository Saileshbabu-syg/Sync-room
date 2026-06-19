CREATE TABLE "room" (
	"room_id" serial PRIMARY KEY NOT NULL,
	"room_name" varchar(100) NOT NULL,
	"room_capacity" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "meeting_attendees" (
	"meeting_attendee_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "meeting_attendees_meeting_id_employee_id_unique" UNIQUE("meeting_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"notification_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"notification_type_id" integer NOT NULL,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notification_type_master" (
	"notification_type_id" serial PRIMARY KEY NOT NULL,
	"notification_type_name" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "notification_type_master_notification_type_name_unique" UNIQUE("notification_type_name")
);
--> statement-breakpoint
CREATE TABLE "reminder_logs" (
	"reminder_log_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"reminder_time" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'SENT',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "recurrence_frequency_master" (
	"frequency_id" serial PRIMARY KEY NOT NULL,
	"frequency_name" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "recurrence_frequency_master_frequency_name_unique" UNIQUE("frequency_name")
);
--> statement-breakpoint
CREATE TABLE "recurring_meetings" (
	"recurring_meeting_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"frequency_id" integer NOT NULL,
	"occurrence_count" integer NOT NULL,
	"recurrence_end_date" date,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_employee_id_employee_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_notification_type_id_notification_type_master_notification_type_id_fk" FOREIGN KEY ("notification_type_id") REFERENCES "public"."notification_type_master"("notification_type_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_meetings" ADD CONSTRAINT "recurring_meetings_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;