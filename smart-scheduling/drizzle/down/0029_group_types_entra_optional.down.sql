-- Manual rollback for 0029 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0029 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Optional-participant flags, sync history and the
-- per-group meeting type lists are lost; Entra object ids are lost too.
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_entra_object_id_unique";
ALTER TABLE "Employee" DROP COLUMN "entra_object_id";
ALTER TABLE "meeting_attendees" DROP COLUMN "is_optional";
DROP TABLE "group_meeting_types";
DROP TABLE "employee_sync_runs";
-- The Admin group (if 0029 created it) is NOT removed: it may hold members. Delete
-- it by hand from Group Management if it was never used.
