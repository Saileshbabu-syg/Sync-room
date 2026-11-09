-- Manual rollback for 0038 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0038 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Deploy the matching application code at the same
-- time: the older code does not read ics_sequence.
--
-- After a rollback, invites go out without a stable UID/SEQUENCE again, so
-- updates and cancellations no longer replace the calendar entries people
-- already have.
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_ics_sequence_nonneg";
ALTER TABLE "meeting" DROP COLUMN "ics_sequence";
