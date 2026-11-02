CREATE TABLE "room_request_holders" (
	"room_request_holder_id" serial PRIMARY KEY NOT NULL,
	"room_request_id" integer NOT NULL,
	"holder_meeting_id" integer NOT NULL,
	"organizer_employee_id" integer NOT NULL,
	"status" varchar(10) DEFAULT 'PENDING' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "room_request_holders_request_meeting_uq" UNIQUE("room_request_id","holder_meeting_id"),
	CONSTRAINT "room_request_holders_status_valid" CHECK ("room_request_holders"."status" IN ('PENDING', 'APPROVED', 'REJECTED'))
);
--> statement-breakpoint
ALTER TABLE "room_request_emails" DROP CONSTRAINT "room_request_emails_request_kind_uq";--> statement-breakpoint
-- Safe for rows created before this migration: add the column nullable, fill it
-- from what each kind of e-mail always meant, then enforce NOT NULL.
ALTER TABLE "room_request_emails" ADD COLUMN "recipient_employee_id" integer;--> statement-breakpoint
UPDATE "room_request_emails" e SET "recipient_employee_id" = CASE
	WHEN e."kind" IN ('SUBMITTED', 'AWAITING_RELEASE', 'CANCELLED') THEN r."holder_organizer_employee_id"
	ELSE r."requester_employee_id"
END FROM "room_requests" r WHERE r."room_request_id" = e."room_request_id";--> statement-breakpoint
ALTER TABLE "room_request_emails" ALTER COLUMN "recipient_employee_id" SET NOT NULL;--> statement-breakpoint
-- Every existing request had exactly one booked meeting in the way.
INSERT INTO "room_request_holders" ("room_request_id", "holder_meeting_id", "organizer_employee_id", "status", "decided_at")
SELECT r."room_request_id", r."holder_meeting_id", r."holder_organizer_employee_id",
	CASE
		WHEN r."status" IN ('AWAITING_SLOT', 'APPROVED') THEN 'APPROVED'
		WHEN r."status" = 'REJECTED' THEN 'REJECTED'
		ELSE 'PENDING'
	END,
	CASE WHEN r."status" IN ('AWAITING_SLOT', 'APPROVED', 'REJECTED') THEN COALESCE(r."organizer_approved_at", r."responded_at") END
FROM "room_requests" r;--> statement-breakpoint
ALTER TABLE "room_request_holders" ADD CONSTRAINT "room_request_holders_room_request_id_room_requests_room_request_id_fk" FOREIGN KEY ("room_request_id") REFERENCES "public"."room_requests"("room_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_request_holders" ADD CONSTRAINT "room_request_holders_holder_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("holder_meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_request_holders" ADD CONSTRAINT "room_request_holders_organizer_employee_id_Employee_employee_id_fk" FOREIGN KEY ("organizer_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_request_holders_organizer_idx" ON "room_request_holders" USING btree ("organizer_employee_id");--> statement-breakpoint
CREATE INDEX "room_request_holders_meeting_idx" ON "room_request_holders" USING btree ("holder_meeting_id");--> statement-breakpoint
ALTER TABLE "room_request_emails" ADD CONSTRAINT "room_request_emails_recipient_employee_id_Employee_employee_id_fk" FOREIGN KEY ("recipient_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_request_emails" ADD CONSTRAINT "room_request_emails_request_kind_recipient_uq" UNIQUE("room_request_id","kind","recipient_employee_id");