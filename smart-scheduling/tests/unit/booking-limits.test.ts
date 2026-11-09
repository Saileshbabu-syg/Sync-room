import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_APP_BOOKING_POLICY,
  DEFAULT_GROUP_BOOKING_POLICY,
  findLimitViolation,
  groupPolicyProblem,
  limitViolationMessage,
  monthOf,
  resolveEffectivePolicy,
  stricter,
  weekOf,
  type AppBookingPolicy,
  type EffectiveLimit,
  type GroupBookingPolicy,
} from "@/lib/booking-limits";

const app = (over: Partial<AppBookingPolicy> = {}): AppBookingPolicy => ({
  ...DEFAULT_APP_BOOKING_POLICY,
  ...over,
});

const group = (over: Partial<GroupBookingPolicy> = {}): GroupBookingPolicy => ({
  ...DEFAULT_GROUP_BOOKING_POLICY,
  ...over,
});

const limit = (value: number | null, source: EffectiveLimit["source"] = "group"): EffectiveLimit => ({
  value,
  source: value === null ? null : source,
});

const none = { perDay: limit(null), perWeek: limit(null), perMonth: limit(null) };

describe("stricter (null = unlimited)", () => {
  it("takes the smaller finite value", () => {
    assert.deepEqual(stricter(240, 120), { value: 120, source: "group" });
    assert.deepEqual(stricter(120, 240), { value: 120, source: "application" });
  });

  it("a group's unlimited never lifts a finite application limit", () => {
    assert.deepEqual(stricter(240, null), { value: 240, source: "application" });
  });

  it("an unlimited application lets the group's own limit apply", () => {
    assert.deepEqual(stricter(null, 90), { value: 90, source: "group" });
  });

  it("both unlimited stays unlimited", () => {
    assert.deepEqual(stricter(null, null), { value: null, source: null });
  });

  it("a tie is the application's (the boundary the group cannot cross)", () => {
    assert.deepEqual(stricter(60, 60), { value: 60, source: "application" });
  });
});

describe("overnight resolution", () => {
  it("application off: prohibited for everyone, whatever the group says", () => {
    for (const overnight of ["INHERIT", "ALLOWED", "NOT_ALLOWED"] as const) {
      assert.equal(resolveEffectivePolicy(app({ allowOvernight: false }), group({ overnight })).allowOvernight, false);
    }
  });

  it("application on + inherit = allowed", () => {
    assert.equal(resolveEffectivePolicy(app({ allowOvernight: true }), group({ overnight: "INHERIT" })).allowOvernight, true);
  });

  it("application on + allowed = allowed", () => {
    assert.equal(resolveEffectivePolicy(app({ allowOvernight: true }), group({ overnight: "ALLOWED" })).allowOvernight, true);
  });

  it("application on + not allowed = prohibited", () => {
    assert.equal(resolveEffectivePolicy(app({ allowOvernight: true }), group({ overnight: "NOT_ALLOWED" })).allowOvernight, false);
  });
});

describe("effective limits", () => {
  it("each limit is the stricter of the application's and the group's", () => {
    const effective = resolveEffectivePolicy(
      app({ maxDurationMinutes: 240, maxBookingsPerDay: 5, maxBookingsPerWeek: 20, maxBookingsPerMonth: null }),
      group({ maxDurationMinutes: 120, maxBookingsPerDay: null, maxBookingsPerWeek: 30, maxBookingsPerMonth: 40 })
    );

    assert.deepEqual(effective.maxDuration, { value: 120, source: "group" });
    assert.deepEqual(effective.perDay, { value: 5, source: "application" });
    assert.deepEqual(effective.perWeek, { value: 20, source: "application" });
    assert.deepEqual(effective.perMonth, { value: 40, source: "group" });
  });

  it("with no settings anywhere nothing is limited (the behaviour before these settings)", () => {
    const effective = resolveEffectivePolicy(app(), group());

    assert.equal(effective.allowOvernight, false);
    assert.equal(effective.maxDuration.value, null);
    assert.equal(effective.perDay.value, null);
    assert.equal(effective.perWeek.value, null);
    assert.equal(effective.perMonth.value, null);
  });

  it("lowering the application limit later tightens a group without changing the group's value", () => {
    const stored = group({ maxBookingsPerDay: 10 });

    assert.equal(resolveEffectivePolicy(app({ maxBookingsPerDay: 20 }), stored).perDay.value, 10);
    assert.equal(resolveEffectivePolicy(app({ maxBookingsPerDay: 3 }), stored).perDay.value, 3);
    assert.equal(stored.maxBookingsPerDay, 10);
  });
});

describe("groupPolicyProblem (saving a group)", () => {
  it("rejects allowing overnight while the application forbids it", () => {
    assert.match(groupPolicyProblem(app({ allowOvernight: false }), group({ overnight: "ALLOWED" }))!, /turned off for the whole application/);
    assert.equal(groupPolicyProblem(app({ allowOvernight: false }), group({ overnight: "NOT_ALLOWED" })), null);
    assert.equal(groupPolicyProblem(app({ allowOvernight: true }), group({ overnight: "ALLOWED" })), null);
  });

  it("rejects a value above the application's limit, naming the limit", () => {
    assert.match(groupPolicyProblem(app({ maxDurationMinutes: 240 }), group({ maxDurationMinutes: 300 }))!, /Maximum meeting duration.*240/);
    assert.match(groupPolicyProblem(app({ maxBookingsPerDay: 3 }), group({ maxBookingsPerDay: 4 }))!, /per day.*3/);
    assert.match(groupPolicyProblem(app({ maxBookingsPerWeek: 10 }), group({ maxBookingsPerWeek: 11 }))!, /per week.*10/);
    assert.match(groupPolicyProblem(app({ maxBookingsPerMonth: 30 }), group({ maxBookingsPerMonth: 31 }))!, /per month.*30/);
  });

  it("accepts equal values, lower values and unlimited", () => {
    assert.equal(groupPolicyProblem(app({ maxBookingsPerDay: 3 }), group({ maxBookingsPerDay: 3 })), null);
    assert.equal(groupPolicyProblem(app({ maxBookingsPerDay: 3 }), group({ maxBookingsPerDay: 2 })), null);
    assert.equal(groupPolicyProblem(app({ maxBookingsPerDay: 3 }), group({ maxBookingsPerDay: null })), null);
    assert.equal(groupPolicyProblem(app(), group({ maxBookingsPerDay: 500 })), null);
  });
});

describe("calendar weeks (Monday to Sunday) and months", () => {
  it("a week starts on Monday and ends on Sunday", () => {
    // 2026-11-09 is a Monday.
    assert.deepEqual(weekOf("2026-11-09"), { start: "2026-11-09", end: "2026-11-15" });
    assert.deepEqual(weekOf("2026-11-12"), { start: "2026-11-09", end: "2026-11-15" });
    assert.deepEqual(weekOf("2026-11-15"), { start: "2026-11-09", end: "2026-11-15" });
    assert.deepEqual(weekOf("2026-11-16"), { start: "2026-11-16", end: "2026-11-22" });
  });

  it("a week can span two months and two years", () => {
    assert.deepEqual(weekOf("2026-12-31"), { start: "2026-12-28", end: "2027-01-03" });
    assert.deepEqual(weekOf("2027-01-01"), { start: "2026-12-28", end: "2027-01-03" });
  });

  it("a month is the calendar month, including leap February", () => {
    assert.deepEqual(monthOf("2026-11-10"), { start: "2026-11-01", end: "2026-11-30" });
    assert.deepEqual(monthOf("2026-12-31"), { start: "2026-12-01", end: "2026-12-31" });
    assert.deepEqual(monthOf("2027-02-15"), { start: "2027-02-01", end: "2027-02-28" });
    assert.deepEqual(monthOf("2028-02-15"), { start: "2028-02-01", end: "2028-02-29" });
  });
});

describe("findLimitViolation", () => {
  const perDay3 = { ...none, perDay: limit(3) };
  const perWeek5 = { ...none, perWeek: limit(5) };
  const perMonth4 = { ...none, perMonth: limit(4) };

  it("allows a booking while the group is under the limit", () => {
    assert.equal(findLimitViolation(perDay3, ["2026-11-10", "2026-11-10"], ["2026-11-10"]), null);
  });

  it("refuses the booking that would pass the daily limit, naming the day", () => {
    const v = findLimitViolation(perDay3, ["2026-11-10", "2026-11-10", "2026-11-10"], ["2026-11-10"])!;

    assert.equal(v.period, "day");
    assert.equal(v.limit, 3);
    assert.equal(v.total, 4);
    assert.equal(v.date, "2026-11-10");
  });

  it("another day is unaffected", () => {
    assert.equal(findLimitViolation(perDay3, ["2026-11-10", "2026-11-10", "2026-11-10"], ["2026-11-11"]), null);
  });

  it("counts the week Monday to Sunday: Sunday and the next Monday are different weeks", () => {
    const fiveInWeek = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];

    assert.equal(findLimitViolation(perWeek5, fiveInWeek, ["2026-11-14"])!.period, "week");
    assert.equal(findLimitViolation(perWeek5, fiveInWeek, ["2026-11-15"])!.period, "week");
    assert.equal(findLimitViolation(perWeek5, fiveInWeek, ["2026-11-16"]), null);
    assert.equal(findLimitViolation(perWeek5, fiveInWeek, ["2026-11-08"]), null);
  });

  it("counts the calendar month: the last day and the first day of the next month are different months", () => {
    const four = ["2026-11-03", "2026-11-12", "2026-11-20", "2026-11-30"];

    assert.equal(findLimitViolation(perMonth4, four, ["2026-11-30"])!.period, "month");
    assert.equal(findLimitViolation(perMonth4, four, ["2026-12-01"]), null);
  });

  it("a series is judged as a whole: occurrences in one week or month add up", () => {
    // Three occurrences in the same week with 3 already booked: 6 > 5.
    const v = findLimitViolation(
      perWeek5,
      ["2026-11-09", "2026-11-10", "2026-11-11"],
      ["2026-11-12", "2026-11-13", "2026-11-14"]
    )!;

    assert.equal(v.period, "week");
    assert.equal(v.total, 6);

    // Weekly occurrences land in different weeks, so only the month adds up.
    assert.equal(
      findLimitViolation(perMonth4, ["2026-11-02"], ["2026-11-09", "2026-11-16", "2026-11-23"]),
      null
    );
    assert.equal(
      findLimitViolation(perMonth4, ["2026-11-02", "2026-11-03"], ["2026-11-09", "2026-11-16", "2026-11-23"])!.period,
      "month"
    );
  });

  it("the series check reports the first occurrence (in date order) that overflows", () => {
    const v = findLimitViolation(perDay3, ["2026-11-17", "2026-11-17", "2026-11-17"], ["2026-11-24", "2026-11-17", "2026-11-10"])!;

    assert.equal(v.date, "2026-11-17");
  });

  it("an unlimited limit never refuses", () => {
    assert.equal(findLimitViolation(none, Array(500).fill("2026-11-10"), ["2026-11-10"]), null);
  });

  it("a move inside the period it leaves gains nothing, even if the group is already over the limit", () => {
    // The limit was lowered to 3 after 4 meetings were booked on the day.
    const four = ["2026-11-10", "2026-11-10", "2026-11-10"]; // the moving meeting is left out by the caller

    assert.equal(findLimitViolation(perDay3, four, ["2026-11-10"], "2026-11-10"), null);
    // Moving it to another day with room is fine; to a full day is not.
    assert.equal(findLimitViolation(perDay3, four, ["2026-11-11"], "2026-11-10"), null);
    assert.equal(findLimitViolation(perDay3, [...four, "2026-11-11", "2026-11-11", "2026-11-11"], ["2026-11-11"], "2026-11-10")!.period, "day");
  });

  it("a move within the same week or month skips only that period", () => {
    const weekFull = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]; // moving meeting excluded
    const both = { ...none, perDay: limit(1), perWeek: limit(5) };

    // 11-14 is in the same week as the date it leaves: the week gains nothing,
    // but the day is a new one and is checked (and is free).
    assert.equal(findLimitViolation(both, weekFull, ["2026-11-14"], "2026-11-10"), null);
    // Moving onto a day that already has a meeting is still a daily overflow.
    assert.equal(findLimitViolation(both, weekFull, ["2026-11-11"], "2026-11-10")!.period, "day");
  });
});

describe("limit messages", () => {
  it("name the policy, who set it and what the period would hold", () => {
    const day = limitViolationMessage(findLimitViolation({ ...none, perDay: limit(3) }, Array(3).fill("2026-11-10"), ["2026-11-10"])!);

    assert.match(day, /Your group can book at most 3 bookings per day/);
    assert.match(day, /Tue, 10 Nov 2026 would have 4/);

    const week = limitViolationMessage(
      findLimitViolation({ ...none, perWeek: limit(1, "application") }, ["2026-11-09"], ["2026-11-12"])!
    );

    assert.match(week, /The application allows at most 1 booking per week \(Monday to Sunday\)/);
    assert.match(week, /week of Mon, 9 Nov 2026, which would have 2/);

    const month = limitViolationMessage(
      findLimitViolation({ ...none, perMonth: limit(2) }, ["2026-11-03", "2026-11-04"], ["2026-11-20"])!,
      true
    );

    assert.match(month, /per month/);
    assert.match(month, /Occurrence on Fri, 20 Nov 2026 falls in November 2026, which would have 3/);
  });
});
