CREATE TABLE "recurring_meeting_skipped_dates" (
	"id" serial PRIMARY KEY NOT NULL,
	"recurring_meeting_id" integer NOT NULL,
	"skipped_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recurring_meetings" ADD COLUMN "pattern_start_date" date;--> statement-breakpoint
ALTER TABLE "recurring_meetings" ADD COLUMN "recurrence_interval" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_meetings" ADD COLUMN "until_date" date;--> statement-breakpoint
ALTER TABLE "recurring_meeting_skipped_dates" ADD CONSTRAINT "recurring_meeting_skipped_dates_recurring_meeting_id_recurring_meetings_recurring_meeting_id_fk" FOREIGN KEY ("recurring_meeting_id") REFERENCES "public"."recurring_meetings"("recurring_meeting_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_meeting_skipped_dates_uq" ON "recurring_meeting_skipped_dates" USING btree ("recurring_meeting_id","skipped_date");--> statement-breakpoint
ALTER TABLE "recurring_meetings" ADD CONSTRAINT "recurring_meetings_interval_range" CHECK ("recurring_meetings"."recurrence_interval" BETWEEN 1 AND 12);--> statement-breakpoint
-- Existing series: their pattern starts at their first booked occurrence.
UPDATE "recurring_meetings" r SET "pattern_start_date" = (SELECT min(m."meeting_date") FROM "meeting" m WHERE m."recurring_meeting_id" = r."recurring_meeting_id") WHERE r."pattern_start_date" IS NULL;
