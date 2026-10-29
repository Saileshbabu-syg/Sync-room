ALTER TABLE "reminder_logs" ALTER COLUMN "status" SET DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "meeting_audit_logs" ADD COLUMN "actor_employee_id" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_logs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_audit_logs" ADD CONSTRAINT "meeting_audit_logs_actor_employee_id_Employee_employee_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."Employee"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_logs_meeting_id_uq" ON "reminder_logs" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "reminder_logs_status_time_idx" ON "reminder_logs" USING btree ("status","reminder_time");--> statement-breakpoint
-- Database-level booking integrity (hand-written: Drizzle cannot express EXCLUDE).
--
-- Pre-flight: refuse to continue with a clear message instead of failing half
-- way through if existing data already violates the rules. Nothing is modified
-- or deleted; fix or cancel the listed meetings and re-run the migration.
DO $$
DECLARE
	bad_rows integer;
	overlapping_pairs integer;
BEGIN
	SELECT count(*) INTO bad_rows FROM "meeting" WHERE "end_time" <= "start_time";
	IF bad_rows > 0 THEN
		RAISE EXCEPTION 'Cannot add meeting_end_after_start: % meeting row(s) have end_time <= start_time. Fix them and re-run.', bad_rows;
	END IF;

	SELECT count(*) INTO overlapping_pairs
	FROM "meeting" a
	JOIN "meeting" b
		ON a."room_id" = b."room_id"
		AND a."meeting_date" = b."meeting_date"
		AND a."meeting_id" < b."meeting_id"
		AND a."start_time" < b."end_time"
		AND a."end_time" > b."start_time"
	WHERE a."meeting_status_id" <> 3 AND b."meeting_status_id" <> 3;
	IF overlapping_pairs > 0 THEN
		RAISE EXCEPTION 'Cannot add meeting_no_room_overlap: % pair(s) of non-cancelled meetings already overlap in the same room. Cancel or move one of each pair and re-run.', overlapping_pairs;
	END IF;
END $$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_end_after_start" CHECK ("end_time" > "start_time");
--> statement-breakpoint
-- Two non-cancelled meetings may not overlap in the same room. Ranges are
-- half-open ([start, end)) so back-to-back meetings are allowed. 3 = Cancelled.
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_room_overlap" EXCLUDE USING gist (
	"room_id" WITH =,
	tsrange(("meeting_date" + "start_time"), ("meeting_date" + "end_time")) WITH &&
) WHERE ("meeting_status_id" <> 3);
