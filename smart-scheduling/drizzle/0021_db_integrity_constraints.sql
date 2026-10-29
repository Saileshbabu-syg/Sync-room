-- Database integrity: CHECK constraints on status/count columns, Employee.email
-- NOT NULL, and a created_at default on availability_master.
--
-- Pre-flight: refuse with a clear message (nothing is modified) if existing
-- data already violates a rule, so a failure doesn't surface as a bare
-- constraint error halfway through.
DO $$
DECLARE
	n integer;
BEGIN
	SELECT count(*) INTO n FROM "Employee" WHERE "email" IS NULL;
	IF n > 0 THEN RAISE EXCEPTION 'Cannot make Employee.email NOT NULL: % employee row(s) have no email. Set or remove them and re-run.', n; END IF;

	SELECT count(*) INTO n FROM "notifications" WHERE "status" NOT IN ('PENDING','SENT','FAILED','SKIPPED') OR "attempts" < 0;
	IF n > 0 THEN RAISE EXCEPTION 'notifications: % row(s) have an unknown status or negative attempts.', n; END IF;

	SELECT count(*) INTO n FROM "reminder_logs" WHERE "status" NOT IN ('PENDING','SENT','SKIPPED','FAILED') OR "attempts" < 0;
	IF n > 0 THEN RAISE EXCEPTION 'reminder_logs: % row(s) have an unknown status or negative attempts.', n; END IF;

	SELECT count(*) INTO n FROM "reschedule_requests"
	WHERE "status" NOT IN ('PENDING','RESCHEDULED','CANCELLED','AUTO_REALLOCATED','AUTO_CANCELLED','WITHDRAWN')
		OR "bumped_meeting_id" = "claimant_meeting_id";
	IF n > 0 THEN RAISE EXCEPTION 'reschedule_requests: % row(s) have an unknown status or bump a meeting with itself.', n; END IF;

	SELECT count(*) INTO n FROM "meeting_types" WHERE "priority_rank" NOT BETWEEN 1 AND 5;
	IF n > 0 THEN RAISE EXCEPTION 'meeting_types: % row(s) have a priority_rank outside 1-5.', n; END IF;

	SELECT count(*) INTO n FROM "meeting" WHERE "participant_count" < 1;
	IF n > 0 THEN RAISE EXCEPTION 'meeting: % row(s) have participant_count < 1.', n; END IF;

	SELECT count(*) INTO n FROM "rooms" WHERE "room_capacity" < 1;
	IF n > 0 THEN RAISE EXCEPTION 'rooms: % row(s) have room_capacity < 1.', n; END IF;

	SELECT count(*) INTO n FROM "recurring_meetings" WHERE "occurrence_count" < 1;
	IF n > 0 THEN RAISE EXCEPTION 'recurring_meetings: % row(s) have occurrence_count < 1.', n; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "availability_master" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "Employee" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_participant_count_positive" CHECK ("meeting"."participant_count" >= 1);--> statement-breakpoint
ALTER TABLE "meeting_types" ADD CONSTRAINT "meeting_types_priority_rank_range" CHECK ("meeting_types"."priority_rank" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_valid" CHECK ("notifications"."status" IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_attempts_nonneg" CHECK ("notifications"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "recurring_meetings" ADD CONSTRAINT "recurring_meetings_occurrence_count_positive" CHECK ("recurring_meetings"."occurrence_count" >= 1);--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_status_valid" CHECK ("reminder_logs"."status" IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED'));--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD CONSTRAINT "reminder_logs_attempts_nonneg" CHECK ("reminder_logs"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_status_valid" CHECK ("reschedule_requests"."status" IN ('PENDING', 'RESCHEDULED', 'CANCELLED', 'AUTO_REALLOCATED', 'AUTO_CANCELLED', 'WITHDRAWN'));--> statement-breakpoint
ALTER TABLE "reschedule_requests" ADD CONSTRAINT "reschedule_requests_distinct_meetings" CHECK ("reschedule_requests"."bumped_meeting_id" <> "reschedule_requests"."claimant_meeting_id");--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_capacity_positive" CHECK ("rooms"."room_capacity" >= 1);