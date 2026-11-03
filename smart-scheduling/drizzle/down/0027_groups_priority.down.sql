-- Manual rollback for 0027 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Cancel or move any PREEMPTED meeting first, then run
-- this and delete the 0027 row from drizzle.__drizzle_migrations and the journal.
UPDATE "meeting" SET "meeting_status_id" = 3 WHERE "meeting_status_id" = 6;
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_no_room_overlap";
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_room_overlap" EXCLUDE USING gist (
	"room_id" WITH =,
	tsrange(("meeting_date" + "start_time"), ("meeting_date" + "end_time")) WITH &&
) WHERE ("meeting_status_id" NOT IN (3, 4));
DROP TRIGGER "booking_priority_history_append_only" ON "booking_priority_history";
DROP TRIGGER "group_audit_logs_append_only" ON "group_audit_logs";
DROP FUNCTION "forbid_audit_change"();
ALTER TABLE "meeting" DROP COLUMN "group_id_at_booking", DROP COLUMN "priority_at_booking";
DROP TABLE "booking_priority_history", "group_audit_logs", "group_permissions", "user_groups", "groups";
DELETE FROM "meeting_statuses" WHERE "meeting_status_id" = 6;
