-- Baseline for databases built from scratch.
--
-- Migrations 0000-0014 were originally applied with `drizzle-kit push` and
-- checked in as empty placeholders, so 0015 failed on an empty database
-- (relation "Employee" does not exist). This file is the schema as of
-- snapshot 0014 (the state 0015 expects), written idempotently.
--
-- Existing environments are unaffected: drizzle only runs migrations whose
-- journal timestamp is newer than the last applied one, and every existing
-- database has already applied 0000 (and everything after it).

CREATE TABLE IF NOT EXISTS "Employee" (
	"employee_id" serial PRIMARY KEY NOT NULL,
	"employee_name" varchar(100) NOT NULL,
	"email" varchar(150),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "Employee_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meeting" (
	"meeting_id" serial PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"room_id" integer NOT NULL,
	"meeting_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rooms" (
	"room_id" serial PRIMARY KEY NOT NULL,
	"room_name" varchar(100) NOT NULL,
	"room_capacity" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meeting_attendees" (
	"meeting_attendee_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "meeting_attendees_meeting_id_employee_id_unique" UNIQUE("meeting_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"notification_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"notification_type_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING',
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_type_master" (
	"notification_type_id" serial PRIMARY KEY NOT NULL,
	"notification_type_name" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "notification_type_master_notification_type_name_unique" UNIQUE("notification_type_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminder_logs" (
	"reminder_log_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"reminder_time" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'SENT',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurrence_frequency_master" (
	"frequency_id" serial PRIMARY KEY NOT NULL,
	"frequency_name" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "recurrence_frequency_master_frequency_name_unique" UNIQUE("frequency_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_meetings" (
	"recurring_meeting_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"frequency_id" integer NOT NULL,
	"occurrence_count" integer NOT NULL,
	"recurrence_end_date" date,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meeting_audit_logs" (
	"audit_log_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"action" varchar(100) NOT NULL,
	"remarks" varchar(255),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "meeting" ADD CONSTRAINT "meeting_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_employee_id_Employee_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notifications" ADD CONSTRAINT "notifications_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notifications" ADD CONSTRAINT "notifications_notification_type_id_notification_type_master_notification_type_id_fk" FOREIGN KEY ("notification_type_id") REFERENCES "public"."notification_type_master"("notification_type_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "recurring_meetings" ADD CONSTRAINT "recurring_meetings_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "recurring_meetings" ADD CONSTRAINT "recurring_meetings_frequency_id_recurrence_frequency_master_frequency_id_fk" FOREIGN KEY ("frequency_id") REFERENCES "public"."recurrence_frequency_master"("frequency_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "meeting_audit_logs" ADD CONSTRAINT "meeting_audit_logs_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
