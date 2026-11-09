import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canUseRoom,
  checkBookingPolicy,
  NO_LIMITS,
  type BookingPolicy,
} from "@/lib/services/booking-policy.service";
import { entraSettingsSchema, createGroupSchema, updateGroupSchema } from "@/lib/validations/group.validator";

const open: BookingPolicy = { groupId: 1, canBookRecurring: true, ...NO_LIMITS };

const booking = (over: Partial<Parameters<typeof checkBookingPolicy>[1]> = {}) => ({
  roomId: 1,
  startTime: "10:00:00",
  endTime: "11:00:00",
  occurrenceDates: ["2031-03-10"],
  isSeries: false,
  ...over,
});

const TODAY = "2031-03-01";

describe("group booking policy (pure rules)", () => {
  it("allows everything when the group has no limits", () => {
    assert.equal(checkBookingPolicy(open, booking(), TODAY), null);
    assert.equal(checkBookingPolicy(open, booking({ isSeries: true, occurrenceDates: Array(12).fill("2031-03-10") }), TODAY), null);
  });

  it("room access: no list means every room, a list means only those", () => {
    assert.equal(canUseRoom(open, 99), true);

    const restricted = { ...open, roomIds: [1, 2] };

    assert.equal(canUseRoom(restricted, 2), true);
    assert.equal(canUseRoom(restricted, 3), false);
    assert.deepEqual(checkBookingPolicy(restricted, booking({ roomId: 3 }), TODAY), {
      status: 403,
      message: "Your group is not allowed to book this room.",
    });
    assert.equal(checkBookingPolicy(restricted, booking({ roomId: 2 }), TODAY), null);
  });

  it("recurring meetings need the permission, single meetings never do", () => {
    const noSeries = { ...open, canBookRecurring: false };

    assert.equal(checkBookingPolicy(noSeries, booking(), TODAY), null);
    assert.equal(checkBookingPolicy(noSeries, booking({ isSeries: true }), TODAY)?.status, 403);
  });

  it("longest meeting, in minutes, inclusive", () => {
    const policy = { ...open, maxDurationMinutes: 90 };

    assert.equal(checkBookingPolicy(policy, booking({ endTime: "11:30:00" }), TODAY), null);

    const problem = checkBookingPolicy(policy, booking({ endTime: "11:31:00" }), TODAY);

    assert.equal(problem?.status, 400);
    assert.match(problem!.message, /at most 90 minutes/);
    assert.match(checkBookingPolicy({ ...open, maxDurationMinutes: 120 }, booking({ endTime: "13:00:00" }), TODAY)!.message, /2 hours/);
  });

  it("how many days ahead, counted from today and checked on the LAST date of a series", () => {
    const policy = { ...open, maxAdvanceDays: 14 };

    assert.equal(checkBookingPolicy(policy, booking({ occurrenceDates: ["2031-03-15"] }), TODAY), null);
    assert.equal(checkBookingPolicy(policy, booking({ occurrenceDates: ["2031-03-16"] }), TODAY)?.status, 400);
    assert.equal(
      checkBookingPolicy(policy, booking({ isSeries: true, occurrenceDates: ["2031-03-08", "2031-03-22"] }), TODAY)?.status,
      400,
      "the last occurrence is too far out"
    );
  });

  it("series length uses the requested count, even if some dates are skipped", () => {
    const policy = { ...open, maxOccurrences: 4 };
    const series = { isSeries: true, occurrenceDates: ["2031-03-10", "2031-03-11"] };

    assert.equal(checkBookingPolicy(policy, booking({ ...series, requestedOccurrences: 4 }), TODAY), null);
    assert.equal(checkBookingPolicy(policy, booking({ ...series, requestedOccurrences: 5 }), TODAY)?.status, 400);
    assert.equal(checkBookingPolicy(policy, booking(), TODAY), null, "a single meeting is not a series");
  });
});

describe("group settings requests", () => {
  const base = { name: "Ops", priority: 3, isActive: true, permissions: [], meetingTypeIds: [] };

  it("default to no limits and every room", () => {
    const parsed = createGroupSchema.parse(base);

    assert.deepEqual(parsed.settings, { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: null });
    assert.deepEqual(parsed.roomIds, []);
  });

  it("limits can only tighten the system limits", () => {
    const ok = updateGroupSchema.safeParse({ settings: { maxDurationMinutes: 60, maxAdvanceDays: 30, maxOccurrences: 6 } });

    assert.equal(ok.success, true);

    for (const settings of [
      { maxDurationMinutes: 5, maxAdvanceDays: null, maxOccurrences: null },
      { maxDurationMinutes: null, maxAdvanceDays: 93, maxOccurrences: null },
      { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: 13 },
      { maxDurationMinutes: null, maxAdvanceDays: 0, maxOccurrences: null },
      { maxDurationMinutes: 60.5, maxAdvanceDays: null, maxOccurrences: null },
    ]) {
      assert.equal(updateGroupSchema.safeParse({ settings }).success, false, JSON.stringify(settings));
    }
  });

  it("new permission keys are accepted, unknown ones rejected", () => {
    assert.equal(updateGroupSchema.safeParse({ permissions: ["booking.recurring", "rooms.manage", "group.manage"] }).success, true);
    assert.equal(updateGroupSchema.safeParse({ permissions: ["rooms.delete.everything"] }).success, false);
  });
});

describe("Entra settings request", () => {
  it("accepts each interval preset", () => {
    for (const intervalHours of [1, 24, 168, 720]) {
      assert.equal(entraSettingsSchema.parse({ autoSyncEnabled: true, defaultGroupId: 1, intervalHours }).intervalHours, intervalHours);
    }

    assert.equal(entraSettingsSchema.parse({ autoSyncEnabled: false, defaultGroupId: 1, intervalHours: 24 }).autoSyncEnabled, false);
  });

  it("rejects anything that is not one of the presets", () => {
    for (const intervalHours of [0, 6, 169, 721, "24"]) {
      assert.equal(entraSettingsSchema.safeParse({ autoSyncEnabled: true, defaultGroupId: 1, intervalHours }).success, false);
    }

    assert.equal(entraSettingsSchema.safeParse({ defaultGroupId: 1, intervalHours: 24 }).success, false);
    assert.equal(entraSettingsSchema.safeParse({ autoSyncEnabled: true, intervalHours: 24 }).success, false, "a default group is required");
  });
});
