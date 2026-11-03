ALTER TABLE "meeting_attendees" ADD COLUMN "response_status" varchar(15) DEFAULT 'NO_RESPONSE' NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "recipient_employee_id" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_employee_id_Employee_employee_id_fk" FOREIGN KEY ("recipient_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_response_valid" CHECK ("meeting_attendees"."response_status" IN ('NO_RESPONSE', 'ACCEPTED', 'DECLINED'));--> statement-breakpoint
-- The organizer never has to answer their own invitation.
UPDATE "meeting_attendees" a SET "response_status" = 'ACCEPTED'
FROM "meeting" m
WHERE m."meeting_id" = a."meeting_id" AND m."organizer_employee_id" = a."employee_id";--> statement-breakpoint
-- The dashboard permission no longer carries a team name in its key. Existing
-- group settings are kept; only the key is renamed.
UPDATE "group_permissions" SET "permission_key" = 'dashboard.view'
WHERE "permission_key" = 'dashboard.hr.view'
  AND NOT EXISTS (
    SELECT 1 FROM "group_permissions" g2
    WHERE g2."group_id" = "group_permissions"."group_id"
      AND g2."permission_key" = 'dashboard.view'
  );
