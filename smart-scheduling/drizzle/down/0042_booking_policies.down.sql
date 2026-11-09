-- Manual rollback for 0042 (drizzle-kit has no down migrations; the migrator
-- ignores this folder). Remove the 0042 row from drizzle.__drizzle_migrations
-- and the journal afterwards. Deploy the matching application code at the
-- same time.
--
-- Only booking-policy configuration is lost: the application-wide settings row
-- and each group's overnight policy and per-day/week/month limits. Groups keep
-- their longest-meeting, days-ahead and series-length limits, and no meeting
-- is touched.
DROP INDEX "meeting_group_date_idx";--> statement-breakpoint
ALTER TABLE "group_settings" DROP CONSTRAINT "group_settings_overnight_valid";--> statement-breakpoint
ALTER TABLE "group_settings" DROP CONSTRAINT "group_settings_per_day_range";--> statement-breakpoint
ALTER TABLE "group_settings" DROP CONSTRAINT "group_settings_per_week_range";--> statement-breakpoint
ALTER TABLE "group_settings" DROP CONSTRAINT "group_settings_per_month_range";--> statement-breakpoint
ALTER TABLE "group_settings" DROP COLUMN "overnight_policy";--> statement-breakpoint
ALTER TABLE "group_settings" DROP COLUMN "max_bookings_per_day";--> statement-breakpoint
ALTER TABLE "group_settings" DROP COLUMN "max_bookings_per_week";--> statement-breakpoint
ALTER TABLE "group_settings" DROP COLUMN "max_bookings_per_month";--> statement-breakpoint
DROP TABLE "app_booking_settings";
