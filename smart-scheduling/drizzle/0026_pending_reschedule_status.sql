-- A meeting bumped by a higher-priority one waits in status 4 (PENDING_RESCHEDULE)
-- for its organizer to pick another room or time. It no longer holds its slot, so
-- the room-overlap constraint must ignore it, like cancelled meetings (3).
--
-- Id 4 is named in lib/constants.ts. db/seed-priority.ts may already have created
-- a PENDING_RESCHEDULE row; it is kept when it already has id 4. Anything else
-- stops the migration instead of leaving the app and the table disagreeing.
INSERT INTO "meeting_statuses" ("meeting_status_id", "meeting_status_name")
VALUES (4, 'PENDING_RESCHEDULE')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "meeting_statuses"
		WHERE "meeting_status_id" = 4 AND "meeting_status_name" = 'PENDING_RESCHEDULE'
	) THEN
		RAISE EXCEPTION 'meeting_statuses id 4 must be PENDING_RESCHEDULE. Rename or move the existing rows, then re-run the migration.';
	END IF;
END $$;--> statement-breakpoint
SELECT setval(
	pg_get_serial_sequence('meeting_statuses', 'meeting_status_id'),
	GREATEST((SELECT max("meeting_status_id") FROM "meeting_statuses"), 1)
);--> statement-breakpoint
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_no_room_overlap";--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_room_overlap" EXCLUDE USING gist (
	"room_id" WITH =,
	tsrange(("meeting_date" + "start_time"), ("meeting_date" + "end_time")) WITH &&
) WHERE ("meeting_status_id" NOT IN (3, 4));
