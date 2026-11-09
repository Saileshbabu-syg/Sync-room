-- Manual rollback for 0041 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0041 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Deploy the matching application code at the
-- same time.
--
-- Archived rooms become ordinary rooms again (bookable, listed): set them to
-- the maintenance status first if they must stay out of use.
ALTER TABLE "rooms" DROP COLUMN "archived_at";
