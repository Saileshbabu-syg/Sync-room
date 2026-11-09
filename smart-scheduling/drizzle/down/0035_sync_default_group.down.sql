-- Manual rollback for 0035 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0035 row from drizzle.__drizzle_migrations
-- and the journal afterwards.
ALTER TABLE "entra_sync_settings" DROP CONSTRAINT "entra_sync_settings_default_group_id_groups_id_fk";
ALTER TABLE "entra_sync_settings" DROP COLUMN "default_group_id";
