import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  durationMinutes,
  isMeetingEnded,
  isSlotStartInPast,
  nowInAppTimezone,
  normalizeTime,
  timeRangesOverlap,
  timeToSeconds,
} from "@/lib/time";

describe("normalizeTime", () => {
  it('treats "11:00" and "11:00:00" as the same time', () => {
    assert.equal(normalizeTime("11:00"), "11:00:00");
    assert.equal(normalizeTime("11:00:00"), "11:00:00");
    assert.equal(timeToSeconds("11:00"), timeToSeconds("11:00:00"));
  });

  it("rejects malformed values", () => {
    for (const bad of ["", "24:00", "9:00", "11:60", "11:00:60", "abc", "11:00:00:00"]) {
      assert.throws(() => normalizeTime(bad), bad);
    }
  });
});

describe("timeRangesOverlap (half-open [start, end))", () => {
  // F-09: the audit's "11:00" vs "11:00:00" string comparison bug.
  it("allows a meeting to start exactly when another ends (both formats)", () => {
    assert.equal(timeRangesOverlap("11:00", "12:00", "10:00:00", "11:00:00"), false);
    assert.equal(timeRangesOverlap("10:00", "11:00", "11:00:00", "12:00:00"), false);
    assert.equal(timeRangesOverlap("11:00:00", "12:00:00", "10:00", "11:00"), false);
  });

  it("detects partial overlap on either side", () => {
    assert.equal(timeRangesOverlap("10:30", "11:30", "10:00:00", "11:00:00"), true);
    assert.equal(timeRangesOverlap("09:30", "10:30", "10:00:00", "11:00:00"), true);
  });

  it("detects complete overlap and containment", () => {
    assert.equal(timeRangesOverlap("10:15", "10:45", "10:00:00", "11:00:00"), true);
    assert.equal(timeRangesOverlap("09:00", "12:00", "10:00:00", "11:00:00"), true);
  });

  it("detects identical start and end", () => {
    assert.equal(timeRangesOverlap("10:00", "11:00", "10:00:00", "11:00:00"), true);
  });

  it("is false for separated slots", () => {
    assert.equal(timeRangesOverlap("12:00", "13:00", "10:00:00", "11:00:00"), false);
  });
});

describe("durationMinutes", () => {
  it("is negative for invalid ordering and zero for identical times", () => {
    assert.equal(durationMinutes("11:00", "10:00"), -60);
    assert.equal(durationMinutes("10:00", "10:00"), 0);
    assert.equal(durationMinutes("10:00", "10:15:00"), 15);
  });
});

describe("application timezone (Asia/Kolkata)", () => {
  it("converts an instant to IST wall-clock date and time", () => {
    // 2026-03-01 20:00 UTC is 2026-03-02 01:30 in IST (UTC+5:30).
    const now = new Date("2026-03-01T20:00:00Z");

    assert.deepEqual(nowInAppTimezone(now), {
      date: "2026-03-02",
      time: "01:30:00",
    });
  });

  it("detects a slot start in the past, but allows the current minute", () => {
    const now = new Date("2026-03-01T06:30:30Z"); // 12:00:30 IST

    assert.equal(isSlotStartInPast("2026-03-01", "11:59", now), true);
    assert.equal(isSlotStartInPast("2026-03-01", "12:00", now), false);
    assert.equal(isSlotStartInPast("2026-03-01", "12:01", now), false);
    assert.equal(isSlotStartInPast("2026-02-28", "23:59", now), true);
    assert.equal(isSlotStartInPast("2026-03-02", "00:00", now), false);
  });

  it("uses the IST date across the UTC date boundary", () => {
    const now = new Date("2026-03-01T19:00:00Z"); // 2026-03-02 00:30 IST

    assert.equal(isSlotStartInPast("2026-03-01", "23:00", now), true);
    assert.equal(isSlotStartInPast("2026-03-02", "00:15", now), true);
    assert.equal(isSlotStartInPast("2026-03-02", "00:30", now), false);
  });

  it("knows when a meeting has ended", () => {
    const now = new Date("2026-03-01T06:30:00Z"); // 12:00:00 IST

    assert.equal(isMeetingEnded("2026-03-01", "11:59:59", now), true);
    assert.equal(isMeetingEnded("2026-03-01", "12:00:00", now), true);
    assert.equal(isMeetingEnded("2026-03-01", "12:00:01", now), false);
    assert.equal(isMeetingEnded("2026-02-28", "23:59:59", now), true);
    assert.equal(isMeetingEnded("2026-03-02", "00:30:00", now), false);
  });
});
