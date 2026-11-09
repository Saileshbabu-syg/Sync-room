-- The Entra sync interval becomes one of four presets (1 hour, 1 day, 1 week,
-- 1 month) and the Entra-group -> app-group mappings are removed.
DROP TABLE "entra_group_mappings" CASCADE;--> statement-breakpoint
ALTER TABLE "entra_sync_settings" DROP CONSTRAINT "entra_sync_settings_interval_range";--> statement-breakpoint
-- Any other saved value moves up to the next preset (the longest, 1 month, if above a week).
UPDATE "entra_sync_settings" SET "interval_hours" = CASE
  WHEN "interval_hours" <= 1 THEN 1
  WHEN "interval_hours" <= 24 THEN 24
  WHEN "interval_hours" <= 168 THEN 168
  ELSE 720
END;--> statement-breakpoint
ALTER TABLE "entra_sync_settings" ADD CONSTRAINT "entra_sync_settings_interval_range" CHECK ("entra_sync_settings"."interval_hours" IN (1, 24, 168, 720));
