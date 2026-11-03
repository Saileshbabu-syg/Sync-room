import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addDays,
  monthFrom,
  PeriodError,
  resolvePeriod,
  weekFrom,
} from "@/lib/report-period";
import { neutralizeFormula } from "@/lib/spreadsheet-safe";

describe("daily period", () => {
  it("uses the given date", () => {
    const p = resolvePeriod({ mode: "day", date: "2031-03-05" });

    assert.deepEqual([p.start, p.end], ["2031-03-05", "2031-03-05"]);
  });

  it("defaults to today in the app timezone, not in UTC", () => {
    // 20:00 UTC on 5 March is already 01:30 on 6 March in Asia/Kolkata.
    const p = resolvePeriod({ mode: "day" }, new Date("2031-03-05T20:00:00Z"));

    assert.equal(p.start, "2031-03-06");

    // 18:00 UTC is 23:30 the same day in Asia/Kolkata.
    assert.equal(
      resolvePeriod({ mode: "day" }, new Date("2031-03-05T18:00:00Z")).start,
      "2031-03-05"
    );
  });
});

describe("weekly period (selected date + the next 6 days)", () => {
  it("starts on whatever date is chosen, not on a Monday", () => {
    for (const [start, end] of [
      ["2031-03-05", "2031-03-11"], // Wednesday
      ["2031-03-09", "2031-03-15"], // Sunday
      ["2031-03-03", "2031-03-09"], // Monday
    ]) {
      assert.deepEqual(weekFrom(start), { start, end }, start);
    }
  });

  it("crosses month and year boundaries", () => {
    assert.deepEqual(weekFrom("2030-12-30"), { start: "2030-12-30", end: "2031-01-05" });
    assert.deepEqual(weekFrom("2031-02-26"), { start: "2031-02-26", end: "2031-03-04" });
    assert.deepEqual(weekFrom("2032-02-26"), { start: "2032-02-26", end: "2032-03-03" });
  });

  it("covers exactly 7 calendar days", () => {
    const { start, end } = weekFrom("2031-03-05");

    assert.equal(addDays(start, 6), end);
  });

  it("resolves from the date, defaulting to today in the app timezone", () => {
    assert.equal(
      resolvePeriod({ mode: "week", date: "2031-03-05" }).label,
      "2031-03-05 to 2031-03-11"
    );
    assert.equal(
      resolvePeriod({ mode: "week" }, new Date("2031-03-05T20:00:00Z")).start,
      "2031-03-06"
    );
  });
});

describe("monthly period (selected date up to the day before the same date next month)", () => {
  it("runs one calendar month from the chosen date", () => {
    assert.deepEqual(monthFrom("2031-11-11"), { start: "2031-11-11", end: "2031-12-10" });
    assert.deepEqual(monthFrom("2031-03-01"), { start: "2031-03-01", end: "2031-03-31" });
    assert.deepEqual(monthFrom("2031-12-31"), { start: "2031-12-31", end: "2032-01-30" });
  });

  it("clamps a date that does not exist next month", () => {
    assert.equal(monthFrom("2031-01-31").end, "2031-02-27");
    assert.equal(monthFrom("2032-01-31").end, "2032-02-28", "leap year");
    assert.equal(monthFrom("2031-02-28").end, "2031-03-27");
  });

  it("resolves from the date", () => {
    const p = resolvePeriod({ mode: "month", date: "2031-11-11" });

    assert.deepEqual([p.start, p.end], ["2031-11-11", "2031-12-10"]);
  });
});

describe("custom range and validation", () => {
  it("accepts a valid inclusive range", () => {
    const p = resolvePeriod({ mode: "range", start: "2031-03-01", end: "2031-03-15" });

    assert.deepEqual([p.start, p.end], ["2031-03-01", "2031-03-15"]);
  });

  it("rejects missing, reversed, impossible and oversized ranges", () => {
    assert.throws(() => resolvePeriod({ mode: "range", start: "2031-03-01" }), PeriodError);
    assert.throws(
      () => resolvePeriod({ mode: "range", start: "2031-03-10", end: "2031-03-01" }),
      PeriodError
    );
    assert.throws(
      () => resolvePeriod({ mode: "range", start: "2031-02-30", end: "2031-03-01" }),
      PeriodError
    );
    assert.throws(
      () => resolvePeriod({ mode: "range", start: "2031-01-01", end: "2032-12-31" }),
      PeriodError
    );
  });

  it("rejects an impossible start date for day, week and month", () => {
    for (const mode of ["day", "week", "month"]) {
      assert.throws(() => resolvePeriod({ mode, date: "2031-02-30" }), PeriodError, mode);
      assert.throws(() => resolvePeriod({ mode, date: "31-01-2031" }), PeriodError, mode);
    }
  });

  it("rejects an unknown mode", () => {
    assert.throws(() => resolvePeriod({ mode: "year" }), PeriodError);
  });
});

describe("spreadsheet formula guard", () => {
  it("neutralizes text a spreadsheet would run as a formula", () => {
    for (const bad of ["=SUM(A1)", "+1", "-1+1", "@cmd", "\tx", "\rx"]) {
      assert.equal(neutralizeFormula(bad), `'${bad}`, JSON.stringify(bad));
    }
  });

  it("leaves ordinary text alone", () => {
    for (const ok of ["Weekly sync", "R&D = fun", "", "1 + 1"]) {
      assert.equal(neutralizeFormula(ok), ok);
    }
  });
});
