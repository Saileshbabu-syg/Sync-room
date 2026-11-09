ALTER TABLE "notifications" DROP CONSTRAINT "notifications_status_valid";--> statement-breakpoint
ALTER TABLE "reminder_logs" DROP CONSTRAINT "reminder_logs_status_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "notifications_status_next_idx" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_valid" CHECK ("notifications"."status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'));--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_status_valid" CHECK ("reminder_logs"."status" IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED'));