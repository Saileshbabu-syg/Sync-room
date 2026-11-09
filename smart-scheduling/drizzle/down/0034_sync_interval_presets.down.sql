-- Manual rollback for 0034 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0034 row from drizzle.__drizzle_migrations
-- and the journal afterwards. The deleted mappings are not restored.
ALTER TABLE "entra_sync_settings" DROP CONSTRAINT "entra_sync_settings_interval_range";
UPDATE "entra_sync_settings" SET "interval_hours" = 168 WHERE "interval_hours" > 168;
ALTER TABLE "entra_sync_settings" ADD CONSTRAINT "entra_sync_settings_interval_range" CHECK ("entra_sync_settings"."interval_hours" BETWEEN 1 AND 168);
CREATE TABLE "entra_group_mappings" (
  "id" serial PRIMARY KEY NOT NULL,
  "entra_group_id" uuid NOT NULL,
  "entra_group_name" varchar(200),
  "group_id" integer NOT NULL,
  CONSTRAINT "entra_group_mappings_entra_group_id_unique" UNIQUE("entra_group_id")
);
ALTER TABLE "entra_group_mappings" ADD CONSTRAINT "entra_group_mappings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "entra_group_mappings_group_idx" ON "entra_group_mappings" USING btree ("group_id");
