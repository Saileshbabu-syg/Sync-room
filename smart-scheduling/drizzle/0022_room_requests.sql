CREATE TABLE "room_requests" (
	"room_request_id" serial PRIMARY KEY NOT NULL,
	"holder_meeting_id" integer NOT NULL,
	"requester_employee_id" integer NOT NULL,
	"room_id" integer NOT NULL,
	"meeting_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"title" varchar(200) NOT NULL,
	"participant_count" integer NOT NULL,
	"meeting_type_id" integer NOT NULL,
	"participant_employee_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"resulting_meeting_id" integer,
	"responded_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "room_requests_status_valid" CHECK ("room_requests"."status" IN ('PENDING', 'APPROVED', 'REJECTED', 'ABANDONED', 'WITHDRAWN', 'FAILED')),
	CONSTRAINT "room_requests_end_after_start" CHECK ("room_requests"."end_time" > "room_requests"."start_time"),
	CONSTRAINT "room_requests_participant_count_positive" CHECK ("room_requests"."participant_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_holder_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("holder_meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_requester_employee_id_Employee_employee_id_fk" FOREIGN KEY ("requester_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_meeting_type_id_meeting_types_meeting_type_id_fk" FOREIGN KEY ("meeting_type_id") REFERENCES "public"."meeting_types"("meeting_type_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_requests" ADD CONSTRAINT "room_requests_resulting_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("resulting_meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_requests_one_pending_per_requester_idx" ON "room_requests" USING btree ("holder_meeting_id","requester_employee_id") WHERE "room_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "room_requests_holder_idx" ON "room_requests" USING btree ("holder_meeting_id");--> statement-breakpoint
CREATE INDEX "room_requests_requester_idx" ON "room_requests" USING btree ("requester_employee_id");--> statement-breakpoint
CREATE INDEX "room_requests_status_date_idx" ON "room_requests" USING btree ("status","meeting_date");