CREATE TABLE "booking_priority_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"incoming_booking_id" integer NOT NULL,
	"affected_booking_id" integer NOT NULL,
	"previous_group_id" integer,
	"previous_priority" integer NOT NULL,
	"incoming_group_id" integer,
	"incoming_priority" integer NOT NULL,
	"reason" varchar(255) NOT NULL,
	"actor_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_employee_id" integer,
	"action" varchar(64) NOT NULL,
	"group_id" integer,
	"target_employee_id" integer,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"permission_key" varchar(64) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "group_permissions_group_key_uq" UNIQUE("group_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"priority" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_priority_range" CHECK ("groups"."priority" BETWEEN 1 AND 1000),
	CONSTRAINT "groups_name_not_blank" CHECK (length(btrim("groups"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"assigned_by" integer,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	CONSTRAINT "user_groups_until_after_assigned" CHECK ("user_groups"."effective_until" IS NULL OR "user_groups"."effective_until" >= "user_groups"."assigned_at")
);
--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "group_id_at_booking" integer;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "priority_at_booking" integer;--> statement-breakpoint
ALTER TABLE "booking_priority_history" ADD CONSTRAINT "booking_priority_history_incoming_booking_id_meeting_meeting_id_fk" FOREIGN KEY ("incoming_booking_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_priority_history" ADD CONSTRAINT "booking_priority_history_affected_booking_id_meeting_meeting_id_fk" FOREIGN KEY ("affected_booking_id") REFERENCES "public"."meeting"("meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_priority_history" ADD CONSTRAINT "booking_priority_history_previous_group_id_groups_id_fk" FOREIGN KEY ("previous_group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_priority_history" ADD CONSTRAINT "booking_priority_history_incoming_group_id_groups_id_fk" FOREIGN KEY ("incoming_group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_priority_history" ADD CONSTRAINT "booking_priority_history_actor_employee_id_Employee_employee_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_audit_logs" ADD CONSTRAINT "group_audit_logs_actor_employee_id_Employee_employee_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_audit_logs" ADD CONSTRAINT "group_audit_logs_target_employee_id_Employee_employee_id_fk" FOREIGN KEY ("target_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_permissions" ADD CONSTRAINT "group_permissions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_employee_id_Employee_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_assigned_by_Employee_employee_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_priority_history_affected_idx" ON "booking_priority_history" USING btree ("affected_booking_id");--> statement-breakpoint
CREATE INDEX "booking_priority_history_incoming_idx" ON "booking_priority_history" USING btree ("incoming_booking_id");--> statement-breakpoint
CREATE INDEX "group_audit_logs_created_idx" ON "group_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_lower_uq" ON "groups" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "user_groups_one_active_per_employee_idx" ON "user_groups" USING btree ("employee_id") WHERE "user_groups"."effective_until" IS NULL;--> statement-breakpoint
CREATE INDEX "user_groups_group_id_idx" ON "user_groups" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_group_id_at_booking_groups_id_fk" FOREIGN KEY ("group_id_at_booking") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- PREEMPTED (id 6; id 5 may already hold PENDING_ROOM): a confirmed booking taken over by a higher-priority group.
-- Like cancelled (3) and pending-reschedule (4) it no longer holds its slot.
INSERT INTO "meeting_statuses" ("meeting_status_id", "meeting_status_name")
VALUES (6, 'PREEMPTED')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "meeting_statuses"
		WHERE "meeting_status_id" = 6 AND "meeting_status_name" = 'PREEMPTED'
	) THEN
		RAISE EXCEPTION 'meeting_statuses id 6 must be PREEMPTED. Rename or move the existing rows, then re-run the migration.';
	END IF;
END $$;--> statement-breakpoint
SELECT setval(
	pg_get_serial_sequence('meeting_statuses', 'meeting_status_id'),
	GREATEST((SELECT max("meeting_status_id") FROM "meeting_statuses"), 1)
);--> statement-breakpoint
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_no_room_overlap";--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_room_overlap" EXCLUDE USING gist (
	"room_id" WITH =,
	tsrange(("meeting_date" + "start_time"), ("meeting_date" + "end_time")) WITH &&
) WHERE ("meeting_status_id" NOT IN (3, 4, 6));--> statement-breakpoint
-- Audit tables are append-only for everybody, application code included.
CREATE FUNCTION "forbid_audit_change"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "booking_priority_history_append_only"
	BEFORE UPDATE OR DELETE ON "booking_priority_history"
	FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "group_audit_logs_append_only"
	BEFORE UPDATE OR DELETE ON "group_audit_logs"
	FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
-- Default groups. Admin is deliberately not a group.
INSERT INTO "groups" ("name", "description", "priority") VALUES
	('Leadership', 'Senior leadership: highest booking priority', 1),
	('HR', 'Human resources', 2),
	('Manager', 'People managers', 3),
	('TL', 'Team leads', 4),
	('Employee', 'All other employees', 5)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "group_permissions" ("group_id", "permission_key", "is_enabled")
SELECT g."id", p."key",
	CASE WHEN p."key" = 'dashboard.hr.view' THEN g."name" = 'HR' ELSE true END
FROM "groups" g
CROSS JOIN (VALUES
	('dashboard.hr.view'), ('booking.create'), ('booking.view'),
	('booking.cancel'), ('booking.priority')
) AS p("key")
WHERE g."name" IN ('Leadership', 'HR', 'Manager', 'TL', 'Employee')
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Carry today's roles over so existing users keep their standing (Manager was
-- already the boosted tier). Admin and unknown roles stay unassigned and get the
-- default policy.
INSERT INTO "user_groups" ("employee_id", "group_id")
SELECT e."employee_id", g."id"
FROM "Employee" e
JOIN "roles" r ON r."role_id" = e."role_id"
JOIN "groups" g ON g."name" = CASE r."role_name"
	WHEN 'Manager' THEN 'Manager'
	WHEN 'Team Lead' THEN 'TL'
	WHEN 'HR' THEN 'HR'
	WHEN 'Employee' THEN 'Employee'
END
ON CONFLICT DO NOTHING;
