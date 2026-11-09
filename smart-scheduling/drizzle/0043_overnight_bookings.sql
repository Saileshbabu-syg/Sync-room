-- Overnight bookings (hand-written: Drizzle cannot express EXCLUDE).
--
-- A meeting keeps one date (the day it starts) and two wall-clock times. When
-- the end time is earlier than the start time it ends on the NEXT day (23:00 ->
-- 01:00), so no column is added and no row is rewritten. Equal times stay
-- invalid. Two things assumed "end after start on the same day":
--   * the meeting_end_after_start check, relaxed to "end differs from start";
--   * the room overlap exclusion constraint, rebuilt on the real end timestamp.
-- Every existing row has end > start, so its range is unchanged: the new
-- constraints accept all existing data and nothing is deleted or modified.
-- Rollback: drizzle/down/0043_overnight_bookings.down.sql.
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_end_after_start";--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_end_differs_from_start" CHECK ("end_time" <> "start_time");--> statement-breakpoint
ALTER TABLE "meeting" DROP CONSTRAINT "meeting_no_room_overlap";--> statement-breakpoint
-- Same exclusions as 0027 (3 = Cancelled, 4 = Preempted, 6 = Pending
-- reschedule hold no slot). The end is the next day for an overnight meeting;
-- keep this expression identical to meetingEndsAt in
-- lib/services/conflict-check.service.ts.
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_no_room_overlap" EXCLUDE USING gist (
	"room_id" WITH =,
	tsrange(
		("meeting_date" + "start_time"),
		("meeting_date" + "end_time" + CASE WHEN "end_time" < "start_time" THEN interval '1 day' ELSE interval '0 day' END)
	) WITH &&
) WHERE ("meeting_status_id" NOT IN (3, 4, 6));
