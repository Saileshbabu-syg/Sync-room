-- Manual rollback for 0036 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0036 row from drizzle.__drizzle_migrations
-- and the journal afterwards.
--
-- Rolling back re-admits everyone the Entra sync deactivated: is_active is
-- dropped, so deactivated people can sign in again. Deploy the matching
-- application code (which no longer checks is_active) at the same time.
DROP INDEX IF EXISTS "organizer_email_lower_idx";
DROP INDEX IF EXISTS "employee_email_lower_idx";
ALTER TABLE "employee_sync_runs" DROP COLUMN "deactivation_note";
ALTER TABLE "employee_sync_runs" DROP COLUMN "deactivated";
ALTER TABLE "Employee" DROP COLUMN "deactivated_at";
ALTER TABLE "Employee" DROP COLUMN "is_active";
