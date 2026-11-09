ALTER TABLE "meeting" ADD COLUMN "online_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "is_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_provider" varchar(40);--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_join_url" text;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_event_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_online_event_id_uq" ON "meeting" USING btree ("online_event_id") WHERE "meeting"."online_event_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_online_consistent" CHECK (NOT "meeting"."is_online" OR ("meeting"."online_join_url" IS NOT NULL AND "meeting"."online_event_id" IS NOT NULL AND "meeting"."online_provider" IS NOT NULL));