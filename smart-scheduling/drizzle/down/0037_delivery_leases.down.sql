-- Manual rollback for 0037 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0037 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Deploy the matching application code at the same
-- time: the older code does not know the SENDING status or the new columns.
--
-- A row claimed when the rollback happens (SENDING) goes back to PENDING so the
-- old code retries it; it may therefore be sent twice. Failure reasons and
-- backoff times are lost.
UPDATE "notifications" SET "status" = 'PENDING' WHERE "status" = 'SENDING';
UPDATE "reminder_logs" SET "status" = 'PENDING' WHERE "status" = 'SENDING';
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_status_valid";
ALTER TABLE "reminder_logs" DROP CONSTRAINT "reminder_logs_status_valid";
DROP INDEX IF EXISTS "notifications_status_next_idx";
ALTER TABLE "notifications" DROP COLUMN "last_error";
ALTER TABLE "notifications" DROP COLUMN "locked_until";
ALTER TABLE "notifications" DROP COLUMN "next_attempt_at";
ALTER TABLE "reminder_logs" DROP COLUMN "last_error";
ALTER TABLE "reminder_logs" DROP COLUMN "locked_until";
ALTER TABLE "reminder_logs" DROP COLUMN "next_attempt_at";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_valid" CHECK ("notifications"."status" IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED'));
ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_status_valid" CHECK ("reminder_logs"."status" IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED'));
