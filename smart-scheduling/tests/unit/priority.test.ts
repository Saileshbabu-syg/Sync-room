import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MEETING_STATUS } from "@/lib/constants";
import {
  classifySlot,
  type OverlappingMeeting,
} from "@/lib/services/priority.service";

// 10:00 on 2026-11-10 in Asia/Kolkata (UTC+05:30, no DST).
const NOW = new Date("2026-11-10T04:30:00.000Z");

function existing(
  overrides: Partial<OverlappingMeeting> = {}
): OverlappingMeeting {
  return {
    meetingId: 1,
    priorityRank: 4,
    statusId: MEETING_STATUS.SCHEDULED,
    meetingDate: "2026-11-10",
    startTime: "14:00:00",
    ...overrides,
  };
}

describe("classifySlot", () => {
  it("never bumps a meeting of equal priority", () => {
    const result = classifySlot(4, [existing({ priorityRank: 4 })], NOW);

    assert.equal(result.state, "BOOKED");
  });

  it("offers a strictly lower-priority meeting as bumpable", () => {
    const victim = existing({ meetingId: 7, priorityRank: 4 });

    const result = classifySlot(3, [victim], NOW);

    assert.deepEqual(result, { state: "BUMPABLE", victims: [victim] });
  });

  it("does not bump a meeting that starts in under an hour", () => {
    // NOW is 10:00; this one starts in 59 minutes.
    const soon = existing({ meetingId: 8, startTime: "10:59:00" });

    const result = classifySlot(3, [soon], NOW);

    assert.deepEqual(result, { state: "BOOKED", blockers: [soon] });
  });

  it("does not bump a meeting that already has a pending reschedule", () => {
    const pending = existing({
      meetingId: 9,
      statusId: MEETING_STATUS.PENDING_RESCHEDULE,
    });

    const result = classifySlot(1, [pending], NOW);

    assert.deepEqual(result, { state: "BOOKED", blockers: [pending] });
  });

  // Characterization pins — already satisfied by the rules above, kept so a
  // later change can't silently loosen them.
  it("is BOOKED, naming only the blockers, when any overlap cannot be bumped", () => {
    const bumpable = existing({ meetingId: 1, priorityRank: 5 });
    const equal = existing({ meetingId: 2, priorityRank: 3 });

    const result = classifySlot(3, [bumpable, equal], NOW);

    assert.deepEqual(result, { state: "BOOKED", blockers: [equal] });
  });

  it("is FREE when nothing overlaps", () => {
    assert.deepEqual(classifySlot(1, [], NOW), { state: "FREE" });
  });

  it("allows a bump when the meeting starts in exactly an hour", () => {
    const edge = existing({ meetingId: 3, startTime: "11:00:00" });

    assert.deepEqual(classifySlot(3, [edge], NOW), {
      state: "BUMPABLE",
      victims: [edge],
    });
  });
});
