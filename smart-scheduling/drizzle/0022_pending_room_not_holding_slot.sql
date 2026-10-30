-- Priority bumping: a PENDING_ROOM meeting is a higher-priority booking waiting
-- for a slot that a lower-priority meeting (PENDING_RESCHEDULE) still holds
-- until its organizer reschedules/cancels or the deadline passes. It must not
-- hold the slot, so it is excluded from the no-overlap rule alongside
-- Cancelled. When it is promoted to Scheduled the constraint applies again,
-- so the transaction has to move/cancel the old meeting first.
--
-- Status ids (lib/constants.ts, db/seed-lookups.ts): 3 = Cancelled,
-- 5 = PENDING_ROOM. This only loosens the existing rule, so no pre-flight
-- check is needed.
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_no_room_overlap";
--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_room_overlap" EXCLUDE USING gist (
	"room_id" WITH =,
	tsrange(("meeting_date" + "start_time"), ("meeting_date" + "end_time")) WITH &&
) WHERE ("meeting_status_id" NOT IN (3, 5));
