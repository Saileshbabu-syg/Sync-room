-- Manual rollback for 0028 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0028 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Participant answers are lost.
UPDATE "group_permissions" SET "permission_key" = 'dashboard.hr.view'
WHERE "permission_key" = 'dashboard.view';
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_recipient_employee_id_Employee_employee_id_fk";
ALTER TABLE "notifications" DROP COLUMN "recipient_employee_id";
ALTER TABLE "meeting_attendees" DROP CONSTRAINT "meeting_attendees_response_valid";
ALTER TABLE "meeting_attendees" DROP COLUMN "response_status", DROP COLUMN "responded_at";
