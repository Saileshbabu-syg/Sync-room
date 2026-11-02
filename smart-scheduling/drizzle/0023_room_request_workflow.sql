CREATE TABLE "room_request_emails" (
	"room_request_email_id" serial PRIMARY KEY NOT NULL,
	"room_request_id" integer NOT NULL,
	"kind" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(200),
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "room_request_emails_request_kind_uq" UNIQUE("room_request_id","kind"),
	CONSTRAINT "room_request_emails_status_valid" CHECK ("room_request_emails"."status" IN ('PENDING', 'SENT', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "room_requests" DROP CONSTRAINT "room_requests_status_valid";--> statement-breakpoint
DROP INDEX "room_requests_one_pending_per_requester_idx";--> statement-breakpoint
-- Safe for a table that already has rows from migration 0022: add the new
-- NOT NULL columns nullable / with a stop-gap value, fill them, then enforce.
ALTER TABLE "room_requests" ADD COLUMN "holder_organizer_employee_id" integer;--> statement-breakpoint
UPDATE "room_requests" r SET "holder_organizer_employee_id" = m."organizer_employee_id" FROM "meeting" m WHERE m."meeting_id" = r."holder_meeting_id";--> statement-breakpoint
ALTER TABLE "room_requests" ALTER COLUMN "holder_organizer_employee_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "room_requests" ADD COLUMN "message" text NOT NULL DEFAULT 'No message provided';--> statement-breakpoint
ALTER TABLE "room_requests" ALTER COLUMN "message" DROP DEFAULT;--> statement-breakpoint
-- Statuses renamed since 0022.
UPDATE "room_requests" SET "status" = 'EXPIRED' WHERE "status" = 'ABANDONED';--> statement-breakpoint
UPDATE "room_requests" SET "status" = 'CANCELLED' WHERE "status" = 'WITHDRAWN';--> statement-breakpoint
ALTER TABLE "room_requests" ADD COLUMN "rejection_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "room_requests" ADD COLUMN "organizer_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_requests" ADD COLUMN "decided_by_employee_id" integer;--> statement-breakpoint
ALTER TABLE "room_requests" ADD COLUMN "client_request_id" varchar(64);--> statement-breakpoint
ALTER TABLE "room_requests" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "room_request_emails" ADD CONSTRAINT "room_request_emails_room_request_id_room_requests_room_request_id_fk" FOREIGN KEY ("room_request_id") REFERENCES "public"."room_requests"("room_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_request_emails_status_idx" ON "room_request_emails" USING btree ("status");--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_holder_organizer_employee_id_Employee_employee_id_fk" FOREIGN KEY ("holder_organizer_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_decided_by_employee_id_Employee_employee_id_fk" FOREIGN KEY ("decided_by_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_requests_one_open_per_requester_idx" ON "room_requests" USING btree ("holder_meeting_id","requester_employee_id") WHERE "room_requests"."status" IN ('PENDING', 'AWAITING_SLOT');--> statement-breakpoint
CREATE UNIQUE INDEX "room_requests_client_request_id_uq" ON "room_requests" USING btree ("requester_employee_id","client_request_id") WHERE "room_requests"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "room_requests_holder_organizer_idx" ON "room_requests" USING btree ("holder_organizer_employee_id");--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_message_length" CHECK (char_length(btrim("room_requests"."message")) BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_status_valid" CHECK ("room_requests"."status" IN ('PENDING', 'AWAITING_SLOT', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'));