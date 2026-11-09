CREATE TABLE "app_booking_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"allow_overnight" boolean DEFAULT false NOT NULL,
	"max_duration_minutes" integer,
	"max_bookings_per_day" integer,
	"max_bookings_per_week" integer,
	"max_bookings_per_month" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "app_booking_settings_single_row" CHECK ("app_booking_settings"."id" = 1),
	CONSTRAINT "app_booking_settings_duration_range" CHECK ("app_booking_settings"."max_duration_minutes" IS NULL OR "app_booking_settings"."max_duration_minutes" BETWEEN 15 AND 1440),
	CONSTRAINT "app_booking_settings_per_day_range" CHECK ("app_booking_settings"."max_bookings_per_day" IS NULL OR "app_booking_settings"."max_bookings_per_day" BETWEEN 1 AND 1000),
	CONSTRAINT "app_booking_settings_per_week_range" CHECK ("app_booking_settings"."max_bookings_per_week" IS NULL OR "app_booking_settings"."max_bookings_per_week" BETWEEN 1 AND 5000),
	CONSTRAINT "app_booking_settings_per_month_range" CHECK ("app_booking_settings"."max_bookings_per_month" IS NULL OR "app_booking_settings"."max_bookings_per_month" BETWEEN 1 AND 20000)
);
--> statement-breakpoint
ALTER TABLE "group_settings" ADD COLUMN "overnight_policy" varchar(12) DEFAULT 'INHERIT' NOT NULL;--> statement-breakpoint
ALTER TABLE "group_settings" ADD COLUMN "max_bookings_per_day" integer;--> statement-breakpoint
ALTER TABLE "group_settings" ADD COLUMN "max_bookings_per_week" integer;--> statement-breakpoint
ALTER TABLE "group_settings" ADD COLUMN "max_bookings_per_month" integer;--> statement-breakpoint
ALTER TABLE "app_booking_settings" ADD CONSTRAINT "app_booking_settings_updated_by_Employee_employee_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_group_date_idx" ON "meeting" USING btree ("group_id_at_booking","meeting_date");--> statement-breakpoint
ALTER TABLE "group_settings" ADD CONSTRAINT "group_settings_overnight_valid" CHECK ("group_settings"."overnight_policy" IN ('INHERIT', 'ALLOWED', 'NOT_ALLOWED'));--> statement-breakpoint
ALTER TABLE "group_settings" ADD CONSTRAINT "group_settings_per_day_range" CHECK ("group_settings"."max_bookings_per_day" IS NULL OR "group_settings"."max_bookings_per_day" BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "group_settings" ADD CONSTRAINT "group_settings_per_week_range" CHECK ("group_settings"."max_bookings_per_week" IS NULL OR "group_settings"."max_bookings_per_week" BETWEEN 1 AND 5000);--> statement-breakpoint
ALTER TABLE "group_settings" ADD CONSTRAINT "group_settings_per_month_range" CHECK ("group_settings"."max_bookings_per_month" IS NULL OR "group_settings"."max_bookings_per_month" BETWEEN 1 AND 20000);