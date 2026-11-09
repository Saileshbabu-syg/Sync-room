import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatTime, formatTimeRange } from "@/lib/format";
import {
  appWallClockToUtc,
  nowInAppTimezone,
  normalizeTime,
  timeRangesOverlap,
  timeToSeconds,
} from "@/lib/time";

// The 12-hour AM/PM display is presentation only. What is picked, sent to the
// API, stored and compared stays 24-hour "HH:mm" / "HH:mm:ss" wall-clock time
// in the application timezone, so a meeting never moves when its label changes.
describe("12-hour display does not change the actual meeting time", () => {
  it("02:30 PM is held as 14:30, stored as 14:30:00 and shown as 02:30 PM again", () => {
    const picked = "14:30"; // the value TimeSelect holds for the "02:30 PM" option
    const stored = normalizeTime(picked); // what the time column keeps / returns

    assert.equal(stored, "14:30:00");
    assert.equal(formatTime(picked), "02:30 PM");
    assert.equal(formatTime(stored), "02:30 PM");
    assert.equal(timeToSeconds(stored), 14 * 3600 + 30 * 60);
  });

  it("every half-hour option round-trips: label, stored value and ordering", () => {
    let previous = -1;

    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      const value = `${hh}:${mm}`;

      assert.equal(timeToSeconds(normalizeTime(value)), minutes * 60);
      assert.ok(minutes > previous, "options stay in chronological order");
      assert.match(formatTime(value), /^(0[1-9]|1[0-2]):[0-5]\d (AM|PM)$/);

      previous = minutes;
    }
  });

  it("a meeting across noon or midnight keeps its length and overlap rules", () => {
    // 11:30 AM - 12:30 PM and 12:00 PM - 01:00 PM overlap; back-to-back does not.
    assert.equal(formatTimeRange("11:30", "12:30"), "11:30 AM - 12:30 PM");
    assert.equal(timeRangesOverlap("11:30", "12:30", "12:00", "13:00"), true);
    assert.equal(timeRangesOverlap("11:30", "12:00", "12:00", "13:00"), false);
    // 12:00 AM is the start of the day, not the end of it.
    assert.equal(formatTime("00:00"), "12:00 AM");
    assert.equal(timeToSeconds("00:00"), 0);
  });

  it("the calendar invite for 02:30 PM lands at the same instant as before (09:00 UTC)", () => {
    // Asia/Kolkata is UTC+05:30 with no daylight saving.
    assert.deepEqual(appWallClockToUtc("2026-11-10", "14:30"), [2026, 11, 10, 9, 0]);
    assert.deepEqual(appWallClockToUtc("2026-11-10", "00:30"), [2026, 11, 9, 19, 0]);
    assert.deepEqual(appWallClockToUtc("2026-11-10", "12:00"), [2026, 11, 10, 6, 30]);
  });

  it("the current wall-clock time stays 24-hour for comparisons", () => {
    const now = nowInAppTimezone(new Date("2026-11-10T09:00:00Z"));

    assert.equal(now.time, "14:30:00");
    assert.equal(formatTime(now.time), "02:30 PM");
  });
});
