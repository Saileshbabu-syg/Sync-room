-- Manual rollback for 0043 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0043 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Deploy the matching application code at the
-- same time.
--
-- Nothing is deleted or rewritten. The old constraints cannot describe a
-- meeting that ends the next day, so the script REFUSES to run while any
-- overnight meeting exists (any status): move those meetings to a same-day slot
-- (or remove them yourself) first. The pre-flight changes nothing.
DO $$
DECLARE
	overnight_rows integer;
BEGIN
	SELECT count(*) INTO overnight_rows FROM "meeting" WHERE "end_time" < "start_time";
	IF overnight_rows > 0 THEN
		RAISE EXCEPTION 'Cannot roll back 0043: % overnight meeting(s) exist (end time earlier than start time). Move them to a same-day slot first; nothing was changed.', overnight_rows;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_no_room_overlap";--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_room_overlap" EXCLUDE USING gist (
	"room_id" WITH =,
	tsrange(("meeting_date" + "start_time"), ("meeting_date" + "end_time")) WITH &&
) WHERE ("meeting_status_id" NOT IN (3, 4, 6));--> statement-breakpoint
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_end_differs_from_start";--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_end_after_start" CHECK ("end_time" > "start_time");
