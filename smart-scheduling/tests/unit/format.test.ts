import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDate, formatDateTime, formatDuration, formatTime, formatTimeRange } from "@/lib/format";

// Phase 6 D-14: one way to show dates and times.
describe("formatting", () => {
  it("shows a stored meeting date as written, whatever the process timezone", () => {
    assert.equal(formatDate("2026-11-05"), "Thu, 5 Nov 2026");
    assert.equal(formatDate("2028-02-29"), "Tue, 29 Feb 2028");
    assert.equal(formatDate("2026-12-31"), "Thu, 31 Dec 2026");
  });

  it("leaves anything that is not a date alone", () => {
    assert.equal(formatDate("garbage"), "garbage");
    assert.equal(formatDate(""), "-");
    assert.equal(formatDate(null), "-");
  });

  it("shows times in 12-hour AM/PM format and drops seconds", () => {
    assert.equal(formatTime("14:30:00"), "02:30 PM");
    assert.equal(formatTime("14:30"), "02:30 PM");
    assert.equal(formatTime("09:15"), "09:15 AM");
    assert.equal(formatTime("09:05:59"), "09:05 AM");
    assert.equal(formatTime(undefined), "-");
    assert.equal(formatTime(""), "-");
    assert.equal(formatTimeRange("10:00:00", "11:30:00"), "10:00 AM - 11:30 AM");
    assert.equal(formatTimeRange("11:30", "13:00"), "11:30 AM - 01:00 PM");
  });

  it("formats a length of time in hours and minutes", () => {
    assert.equal(formatDuration(120), "2 hours");
    assert.equal(formatDuration(60), "1 hour");
    assert.equal(formatDuration(90), "1 hour 30 minutes");
    assert.equal(formatDuration(45), "45 minutes");
    assert.equal(formatDuration(15), "15 minutes");
    assert.equal(formatDuration(1440), "24 hours");
  });

  it("handles midnight and noon", () => {
    assert.equal(formatTime("00:00"), "12:00 AM");
    assert.equal(formatTime("00:30:00"), "12:30 AM");
    assert.equal(formatTime("12:00"), "12:00 PM");
    assert.equal(formatTime("12:45:00"), "12:45 PM");
    assert.equal(formatTime("11:59"), "11:59 AM");
    assert.equal(formatTime("13:00"), "01:00 PM");
    assert.equal(formatTime("23:59"), "11:59 PM");
  });

  it("covers every half hour of the day with the right AM/PM and no duplicates", () => {
    const labels = new Set<string>();

    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const label = formatTime(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);

        assert.match(label, /^(0[1-9]|1[0-2]):[0-5]\d (AM|PM)$/);
        assert.equal(label.endsWith("AM"), h < 12);
        labels.add(label);
      }
    }

    assert.equal(labels.size, 48);
  });

  it("leaves anything that is not a valid time alone", () => {
    assert.equal(formatTime("24:00"), "24:00");
    assert.equal(formatTime("9:15"), "9:15");
    assert.equal(formatTime("25:00"), "25:00");
    assert.equal(formatTime("garbage"), "garbage");
  });

  it("shows an instant in the application timezone (Asia/Kolkata), 12-hour", () => {
    // 18:45 UTC is 00:15 the next day in Kolkata (+05:30).
    assert.equal(formatDateTime(new Date("2026-11-05T18:45:00Z")), "6 Nov 2026, 12:15 AM");
    assert.equal(formatDateTime("2026-11-05T03:00:00Z"), "5 Nov 2026, 08:30 AM");
    // 08:30 UTC is 14:00 in Kolkata.
    assert.equal(formatDateTime("2026-11-05T08:30:00Z"), "5 Nov 2026, 02:00 PM");
    // 06:30 UTC is 12:00 noon in Kolkata.
    assert.equal(formatDateTime("2026-11-05T06:30:00Z"), "5 Nov 2026, 12:00 PM");
    assert.equal(formatDateTime("not a date"), "-");
  });
});
