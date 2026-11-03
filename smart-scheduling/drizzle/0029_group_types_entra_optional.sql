CREATE TABLE "employee_sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" varchar(16) DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"triggered_by" integer,
	"fetched" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"linked" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "employee_sync_runs_status_valid" CHECK ("employee_sync_runs"."status" IN ('RUNNING', 'SUCCESS', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "group_meeting_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"meeting_type_id" integer NOT NULL,
	CONSTRAINT "group_meeting_types_group_type_uq" UNIQUE("group_id","meeting_type_id")
);
--> statement-breakpoint
ALTER TABLE "Employee" ADD COLUMN "entra_object_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD COLUMN "is_optional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_sync_runs" ADD CONSTRAINT "employee_sync_runs_triggered_by_Employee_employee_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_meeting_types" ADD CONSTRAINT "group_meeting_types_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_meeting_types" ADD CONSTRAINT "group_meeting_types_meeting_type_id_meeting_types_meeting_type_id_fk" FOREIGN KEY ("meeting_type_id") REFERENCES "public"."meeting_types"("meeting_type_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_sync_runs_started_idx" ON "employee_sync_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_sync_runs_one_running_idx" ON "employee_sync_runs" USING btree ("status") WHERE "employee_sync_runs"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "group_meeting_types_type_idx" ON "group_meeting_types" USING btree ("meeting_type_id");--> statement-breakpoint
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_entra_object_id_unique" UNIQUE("entra_object_id");--> statement-breakpoint
-- Admin is an application group like the others. It already exists on
-- databases where an admin created it by hand; this only adds it where it is
-- missing (new databases), so nothing existing is changed.
INSERT INTO "groups" ("name", "description", "priority")
SELECT 'Admin', 'Application administrators', 5
WHERE NOT EXISTS (SELECT 1 FROM "groups" WHERE lower("name") = 'admin');--> statement-breakpoint
INSERT INTO "group_permissions" ("group_id", "permission_key", "is_enabled")
SELECT g."id", p."key", true
FROM "groups" g
CROSS JOIN (VALUES
	('dashboard.view'), ('booking.create'), ('booking.view'),
	('booking.cancel'), ('booking.priority')
) AS p("key")
WHERE lower(g."name") = 'admin'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Start each group with what its namesake role may book today, so nobody
-- loses a meeting type when booking moves from roles to groups. Leadership
-- (no role of its own) starts with every type. Admins can change all of it.
INSERT INTO "group_meeting_types" ("group_id", "meeting_type_id")
SELECT g."id", mt."meeting_type_id"
FROM "groups" g
CROSS JOIN "meeting_types" mt
WHERE g."name" = 'Leadership'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "group_meeting_types" ("group_id", "meeting_type_id")
SELECT g."id", rm."meeting_type_id"
FROM "groups" g
JOIN "roles" r ON r."role_name" = CASE g."name" WHEN 'TL' THEN 'Team Lead' ELSE g."name" END
JOIN "role_meeting_types" rm ON rm."role_id" = r."role_id"
WHERE g."name" <> 'Leadership'
ON CONFLICT DO NOTHING;
