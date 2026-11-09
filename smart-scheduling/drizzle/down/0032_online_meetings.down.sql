-- Manual rollback for 0032 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0032 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Teams join links and event ids are lost: delete
-- the calendar events in the organizer mailbox first if they should not stay.
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_online_consistent";
DROP INDEX "meeting_online_event_id_uq";
ALTER TABLE "meeting" DROP COLUMN "online_event_id";
ALTER TABLE "meeting" DROP COLUMN "online_join_url";
ALTER TABLE "meeting" DROP COLUMN "online_provider";
ALTER TABLE "meeting" DROP COLUMN "is_online";
ALTER TABLE "meeting" DROP COLUMN "online_requested";
