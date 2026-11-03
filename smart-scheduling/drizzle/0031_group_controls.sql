CREATE TABLE "entra_group_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"entra_group_id" uuid NOT NULL,
	"entra_group_name" varchar(200),
	"group_id" integer NOT NULL,
	CONSTRAINT "entra_group_mappings_entra_group_id_unique" UNIQUE("entra_group_id")
);
--> statement-breakpoint
CREATE TABLE "entra_sync_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"auto_sync_enabled" boolean DEFAULT false NOT NULL,
	"interval_hours" integer DEFAULT 24 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "entra_sync_settings_single_row" CHECK ("entra_sync_settings"."id" = 1),
	CONSTRAINT "entra_sync_settings_interval_range" CHECK ("entra_sync_settings"."interval_hours" BETWEEN 1 AND 168)
);
--> statement-breakpoint
CREATE TABLE "group_rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"room_id" integer NOT NULL,
	CONSTRAINT "group_rooms_group_room_uq" UNIQUE("group_id","room_id")
);
--> statement-breakpoint
CREATE TABLE "group_settings" (
	"group_id" integer PRIMARY KEY NOT NULL,
	"max_duration_minutes" integer,
	"max_advance_days" integer,
	"max_occurrences" integer,
	CONSTRAINT "group_settings_duration_range" CHECK ("group_settings"."max_duration_minutes" IS NULL OR "group_settings"."max_duration_minutes" BETWEEN 15 AND 1440),
	CONSTRAINT "group_settings_advance_range" CHECK ("group_settings"."max_advance_days" IS NULL OR "group_settings"."max_advance_days" BETWEEN 1 AND 92),
	CONSTRAINT "group_settings_occurrences_range" CHECK ("group_settings"."max_occurrences" IS NULL OR "group_settings"."max_occurrences" BETWEEN 1 AND 12)
);
--> statement-breakpoint
ALTER TABLE "entra_group_mappings" ADD CONSTRAINT "entra_group_mappings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entra_sync_settings" ADD CONSTRAINT "entra_sync_settings_updated_by_Employee_employee_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_rooms" ADD CONSTRAINT "group_rooms_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_rooms" ADD CONSTRAINT "group_rooms_room_id_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_settings" ADD CONSTRAINT "group_settings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entra_group_mappings_group_idx" ON "entra_group_mappings" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_rooms_room_idx" ON "group_rooms" USING btree ("room_id");--> statement-breakpoint
-- The single Entra sync settings row (automatic sync off until an admin turns it on).
INSERT INTO "entra_sync_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Two new permissions. Recurring meetings stay available to every group (so
-- nothing changes today); room management starts with the Admin group only
-- (the Admin role keeps it regardless).
INSERT INTO "group_permissions" ("group_id", "permission_key", "is_enabled")
SELECT g."id", 'booking.recurring', true FROM "groups" g
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "group_permissions" ("group_id", "permission_key", "is_enabled")
SELECT g."id", 'rooms.manage', lower(g."name") = 'admin' FROM "groups" g
ON CONFLICT DO NOTHING;
