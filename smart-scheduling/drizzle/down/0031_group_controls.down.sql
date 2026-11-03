-- Manual rollback for 0031 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0031 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Per-group limits, room lists, Entra settings and
-- mappings are lost.
DELETE FROM "group_permissions" WHERE "permission_key" IN ('booking.recurring', 'rooms.manage');
DROP TABLE "entra_group_mappings";
DROP TABLE "entra_sync_settings";
DROP TABLE "group_rooms";
DROP TABLE "group_settings";
