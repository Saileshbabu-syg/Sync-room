ALTER TABLE "recurring_meetings" DROP CONSTRAINT "recurring_meetings_meeting_id_meeting_meeting_id_fk";
--> statement-breakpoint
DROP INDEX "recurring_meetings_meeting_id_idx";--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "recurring_meeting_id" integer;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_recurring_meeting_id_recurring_meetings_recurring_meeting_id_fk" FOREIGN KEY ("recurring_meeting_id") REFERENCES "public"."recurring_meetings"("recurring_meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_recurring_meeting_id_idx" ON "meeting" USING btree ("recurring_meeting_id");--> statement-breakpoint
ALTER TABLE "recurring_meetings" DROP COLUMN "meeting_id";