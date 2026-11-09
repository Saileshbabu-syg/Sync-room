ALTER TABLE "meeting" ADD COLUMN "online_status" varchar(10) DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_last_error" text;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "online_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "meeting_online_pending_idx" ON "meeting" USING btree ("online_status","online_next_attempt_at") WHERE "meeting"."online_status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_online_status_valid" CHECK ("meeting"."online_status" IN ('NONE', 'PENDING', 'READY', 'FAILED'));--> statement-breakpoint
-- Existing rows: a stored Teams event is READY; Teams asked for but never
-- created (the old synchronous attempt failed) on a meeting that still
-- happens is FAILED, so a person can retry it (no event is created behind
-- anyone's back on deploy); everything else is NONE.
UPDATE "meeting" SET "online_status" = 'READY', "online_synced_at" = COALESCE("updated_at", now()) WHERE "is_online" AND "online_event_id" IS NOT NULL AND "online_join_url" IS NOT NULL;
--> statement-breakpoint
UPDATE "meeting" SET "online_status" = 'FAILED', "online_last_error" = 'Created before background provisioning and not completed. Use Retry.' WHERE "online_requested" AND NOT "is_online" AND "meeting_status_id" IN (1, 4);
