-- Manual rollback for 0033 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0033 row from drizzle.__drizzle_migrations
-- and the journal afterwards.
DELETE FROM "group_permissions" WHERE "permission_key" IN ('booking.outranks', 'booking.protected');
