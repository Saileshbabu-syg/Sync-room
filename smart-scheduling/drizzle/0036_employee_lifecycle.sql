ALTER TABLE "Employee" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "Employee" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employee_sync_runs" ADD COLUMN "deactivated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_sync_runs" ADD COLUMN "deactivation_note" text;--> statement-breakpoint
CREATE INDEX "employee_email_lower_idx" ON "Employee" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "organizer_email_lower_idx" ON "Organizer" USING btree (lower("email"));