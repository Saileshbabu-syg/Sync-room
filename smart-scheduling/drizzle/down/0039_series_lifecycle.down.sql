-- Manual rollback for 0039 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0039 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Deploy the matching application code at the same
-- time.
--
-- Lost on rollback: the stored pattern (start date, every-N-weeks interval,
-- end-by date) and the persisted skipped dates. Occurrences already booked are
-- untouched (they are meeting rows). A series booked "every 2 weeks" keeps its
-- dates, but the older code would describe it as weekly.
ALTER TABLE "recurring_meetings" DROP CONSTRAINT "recurring_meetings_interval_range";
DROP TABLE "recurring_meeting_skipped_dates";
ALTER TABLE "recurring_meetings" DROP COLUMN "until_date";
ALTER TABLE "recurring_meetings" DROP COLUMN "recurrence_interval";
ALTER TABLE "recurring_meetings" DROP COLUMN "pattern_start_date";
