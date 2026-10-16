CREATE TABLE "reschedule_requests" (
	"reschedule_request_id" serial PRIMARY KEY NOT NULL,
	"bumped_meeting_id" integer NOT NULL,
	"claimant_meeting_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "role_meeting_types" (
	"role_meeting_type_id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"meeting_type_id" integer NOT NULL,
	CONSTRAINT "role_meeting_types_role_id_meeting_type_id_unique" UNIQUE("role_id","meeting_type_id")
);
--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "image_url" varchar(255);--> statement-breakpoint
ALTER TABLE "meeting_types" ADD COLUMN "priority_rank" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_bumped_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("bumped_meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_claimant_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("claimant_meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_meeting_types" ADD CONSTRAINT "role_meeting_types_role_id_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("role_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_meeting_types" ADD CONSTRAINT "role_meeting_types_meeting_type_id_meeting_types_meeting_type_id_fk" FOREIGN KEY ("meeting_type_id") REFERENCES "public"."meeting_types"("meeting_type_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reschedule_requests_one_pending_per_bumped_idx" ON "reschedule_requests" USING btree ("bumped_meeting_id") WHERE "reschedule_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reschedule_requests_claimant_idx" ON "reschedule_requests" USING btree ("claimant_meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reschedule_requests_status_deadline_idx" ON "reschedule_requests" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_meeting_types_meeting_type_id_idx" ON "role_meeting_types" USING btree ("meeting_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_role_id_idx" ON "Employee" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_room_date_idx" ON "meeting" USING btree ("room_id","meeting_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_organizer_employee_id_idx" ON "meeting" USING btree ("organizer_employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_status_id_idx" ON "meeting" USING btree ("meeting_status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_type_id_idx" ON "meeting" USING btree ("meeting_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rooms_availability_status_id_idx" ON "rooms" USING btree ("availability_status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_attendees_employee_id_idx" ON "meeting_attendees" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_meeting_id_idx" ON "notifications" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_type_id_idx" ON "notifications" USING btree ("notification_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_logs_meeting_id_idx" ON "reminder_logs" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_meetings_meeting_id_idx" ON "recurring_meetings" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_meetings_frequency_id_idx" ON "recurring_meetings" USING btree ("frequency_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_audit_logs_meeting_id_idx" ON "meeting_audit_logs" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_organizer_id_idx" ON "Account" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizer_employee_id_idx" ON "Organizer" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_organizer_id_idx" ON "Session" USING btree ("organizer_id");