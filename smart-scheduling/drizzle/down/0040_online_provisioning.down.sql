-- Manual rollback for 0040 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0040 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Deploy the matching (older) application code at
-- the same time: it creates Teams events synchronously during the booking.
--
-- Lost on rollback: the provisioning status, retry bookkeeping and last error.
-- Stored Teams events and links (is_online, online_join_url, online_event_id)
-- are kept. Meetings still PENDING have no Teams event yet; with the older code
-- they look like a failed creation and can be retried from the booking page.
DROP INDEX IF EXISTS "meeting_online_pending_idx";
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_online_status_valid";
ALTER TABLE "meeting" DROP COLUMN "online_synced_at";
ALTER TABLE "meeting" DROP COLUMN "online_last_error";
ALTER TABLE "meeting" DROP COLUMN "online_locked_until";
ALTER TABLE "meeting" DROP COLUMN "online_next_attempt_at";
ALTER TABLE "meeting" DROP COLUMN "online_attempts";
ALTER TABLE "meeting" DROP COLUMN "online_version";
ALTER TABLE "meeting" DROP COLUMN "online_status";
