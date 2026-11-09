import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_RECURRENCE_INTERVAL,
  computeOccurrenceDates,
  intervalProblem,
} from "@/lib/recurrence";
import {
  LEAD_TIME_MESSAGE,
  MIN_LEAD_MINUTES,
  hasMinimumLead,
} from "@/lib/validations/date-time";
import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";
import { recurringMeetingSchema } from "@/lib/validations/recurring-meeting";

import { dateFromToday } from "../helpers/fixtures";

// Phase 4: L-2 (every N weeks, end-by date), B-09 (lead time), H-1 (scope).

describe("every N weeks and end-by date (L-2)", () => {
  it("steps N weeks on the same weekday", () => {
    assert.deepEqual(computeOccurrenceDates("2026-11-02", "WEEKLY", 4, { interval: 2 }), [
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
      "2026-12-14",
    ]);
    assert.deepEqual(computeOccurrenceDates("2026-11-02", "WEEKLY", 3, { interval: 3 }), [
      "2026-11-02",
      "2026-11-23",
      "2026-12-14",
    ]);
  });

  it("every 1 week is the plain weekly series (compatibility)", () => {
    assert.deepEqual(
      computeOccurrenceDates("2026-11-02", "WEEKLY", 5, { interval: 1 }),
      computeOccurrenceDates("2026-11-02", "WEEKLY", 5)
    );
  });

  it("the end-by date is inclusive and stops the series", () => {
    assert.deepEqual(computeOccurrenceDates("2026-11-02", "WEEKLY", 12, { until: "2026-11-16" }), [
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
    // The count still caps it when it comes first.
    assert.equal(computeOccurrenceDates("2026-11-02", "WEEKLY", 2, { until: "2027-01-01" }).length, 2);
    // Daily keeps to working days up to the end date.
    assert.deepEqual(computeOccurrenceDates("2026-11-06", "DAILY", 12, { until: "2026-11-10" }), [
      "2026-11-06",
      "2026-11-09",
      "2026-11-10",
    ]);
  });

  it("crosses month ends and daylight-saving dates without shifting a date", () => {
    // Europe/US daylight-saving changes happen on these weekends; the dates are
    // plain calendar dates, so nothing moves.
    assert.deepEqual(computeOccurrenceDates("2027-03-22", "WEEKLY", 3, { interval: 1 }), [
      "2027-03-22",
      "2027-03-29",
      "2027-04-05",
    ]);
    assert.deepEqual(computeOccurrenceDates("2026-10-19", "WEEKLY", 3, { interval: 1 }), [
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
  });

  it("never produces duplicates", () => {
    const dates = computeOccurrenceDates("2026-11-02", "WEEKLY", 12, { interval: 2 });
    assert.equal(new Set(dates).size, dates.length);
    assert.deepEqual([...dates].sort(), dates);
  });

  it("validates the interval: whole numbers 1..12, and only for weekly series", () => {
    assert.equal(intervalProblem("WEEKLY", 2), null);
    assert.equal(intervalProblem("DAILY", 1), null);

    for (const bad of [0, -1, 1.5, MAX_RECURRENCE_INTERVAL + 1, "2", null]) {
      assert.ok(intervalProblem("WEEKLY", bad), String(bad));
    }

    assert.ok(intervalProblem("MONTHLY", 2));
    assert.ok(intervalProblem("DAILY", 2));
    assert.throws(() => computeOccurrenceDates("2026-11-02", "MONTHLY", 3, { interval: 2 }), RangeError);
  });

  const series = (o: Record<string, unknown>) => ({
    title: "Standup",
    room_id: 1,
    meeting_date: dateFromToday(7),
    start_time: "10:00",
    end_time: "10:30",
    participantCount: 1,
    meetingTypeId: 1,
    frequency_id: 2,
    ...o,
  });

  it("the request needs a count or an end date, and an end date not before the start", () => {
    assert.equal(recurringMeetingSchema.safeParse(series({ occurrence_count: 3 })).success, true);
    assert.equal(recurringMeetingSchema.safeParse(series({ end_date: dateFromToday(30) })).success, true);
    assert.equal(recurringMeetingSchema.safeParse(series({})).success, false);
    assert.equal(recurringMeetingSchema.safeParse(series({ end_date: dateFromToday(6) })).success, false);
    assert.equal(recurringMeetingSchema.safeParse(series({ occurrence_count: 2, interval: 0 })).success, false);
    assert.equal(recurringMeetingSchema.safeParse(series({ occurrence_count: 2, interval: 13 })).success, false);
    assert.equal(recurringMeetingSchema.safeParse(series({ end_date: "2026-02-30" })).success, false);
  });
});

describe("15-minute lead time (B-09)", () => {
  const now = new Date("2026-12-01T04:30:00Z"); // 10:00 in Asia/Kolkata

  it("refuses less than 15 minutes ahead, accepts exactly 15, on the app's clock", () => {
    assert.equal(MIN_LEAD_MINUTES, 15);
    assert.equal(hasMinimumLead("2026-12-01", "10:14", now), false);
    assert.equal(hasMinimumLead("2026-12-01", "10:15", now), true);
    assert.equal(hasMinimumLead("2026-12-02", "00:05", now), true);
    assert.equal(hasMinimumLead("2026-11-30", "23:00", now), false);
  });

  it("works across midnight", () => {
    const late = new Date("2026-12-01T18:20:00Z"); // 23:50 IST

    assert.equal(hasMinimumLead("2026-12-02", "00:04", late), false);
    assert.equal(hasMinimumLead("2026-12-02", "00:05", late), true);
  });

  it("is part of the booking schemas", () => {
    const soon = recurringMeetingSchema.safeParse(
      series2(new Date())
    );
    assert.equal(soon.success, false);
    assert.ok(soon.error!.issues.some((i) => i.message === LEAD_TIME_MESSAGE));
  });
});

// A series starting 5 minutes from now (always too soon).
function series2(now: Date) {
  const soon = new Date(now.getTime() + 5 * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(soon);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;

  return {
    title: "Standup",
    room_id: 1,
    meeting_date: `${get("year")}-${get("month")}-${get("day")}`,
    start_time: `${get("hour")}:${get("minute")}`,
    end_time: "23:59",
    participantCount: 1,
    meetingTypeId: 1,
    frequency_id: 2,
    occurrence_count: 2,
  };
}

describe("edit request scope (H-1)", () => {
  it("defaults to this occurrence and accepts the three scopes only", () => {
    assert.equal(editMeetingSchema.parse({ title: "x" }).scope, "single");

    for (const scope of ["single", "following", "series"]) {
      assert.equal(editMeetingSchema.safeParse({ title: "x", scope }).success, true);
    }

    assert.equal(editMeetingSchema.safeParse({ title: "x", scope: "all" }).success, false);
  });

  it("a new time of day needs both ends and at least 15 minutes", () => {
    assert.equal(editMeetingSchema.safeParse({ scope: "series", start_time: "10:00" }).success, false);
    assert.equal(editMeetingSchema.safeParse({ scope: "series", start_time: "10:00", end_time: "10:14" }).success, false);
    assert.equal(editMeetingSchema.safeParse({ scope: "series", start_time: "10:00", end_time: "10:15" }).success, true);
  });
});
