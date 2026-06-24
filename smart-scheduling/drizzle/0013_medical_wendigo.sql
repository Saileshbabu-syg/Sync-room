CREATE TABLE "meeting_audit_logs" (
	"audit_log_id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"action" varchar(100) NOT NULL,
	"remarks" varchar(255),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "meeting_audit_logs" ADD CONSTRAINT "meeting_audit_logs_meeting_id_meeting_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;