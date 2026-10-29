// Priority rules for room bumping — pure decisions, no database.
//
// Rank is lower = more important (1 Client, 2 Interview, 3 Team Meeting,
// 4 Training / One-on-One, 5 Others). A booking can take a slot from a meeting
// only when it is STRICTLY more important; equal rank never bumps.
//
// STATUS TRANSITIONS (meeting.meeting_status_id)
//   SCHEDULED(1) --bumped--------------> PENDING_RESCHEDULE(4)   holds its slot
//   PENDING_RESCHEDULE(4) --rescheduled-> SCHEDULED(1)           at the new slot
//   PENDING_RESCHEDULE(4) --cancelled---> CANCELLED(3)
//   (new booking) --bumps others-------> PENDING_ROOM(5)         holds nothing
//   PENDING_ROOM(5) --request resolved-> SCHEDULED(1)            takes the slot
//
// REQUEST TRANSITIONS (reschedule_requests.status)
//   PENDING -> RESCHEDULED | CANCELLED     organizer responds before deadline
//   PENDING -> AUTO_REALLOCATED | AUTO_CANCELLED   cron after deadline (Phase 6)
//   PENDING -> WITHDRAWN                   claimant gives up (Phase 4)
//   Every other status is terminal; a resolved request is never reopened.

import { MEETING_STATUS } from "@/lib/constants";
import { minutesUntilStart } from "@/lib/time";

// A meeting can only be bumped when it starts at least this long after the
// moment the higher-priority booking is made.
export const BUMP_MIN_LEAD_MINUTES = 60;

export type OverlappingMeeting = {
  meetingId: number;
  priorityRank: number;
  statusId: number;
  meetingDate: string;
  startTime: string;
};

export type SlotState =
  | { state: "FREE" }
  | { state: "BUMPABLE"; victims: OverlappingMeeting[] }
  | { state: "BOOKED"; blockers: OverlappingMeeting[] };

export function classifySlot(
  requestedRank: number,
  overlaps: OverlappingMeeting[],
  now: Date
): SlotState {
  const blockers = overlaps.filter(
    (m) =>
      // Only a plain SCHEDULED meeting can be bumped: a pending one already has
      // a claim on it (one claim per slot), a completed one is over.
      m.statusId !== MEETING_STATUS.SCHEDULED ||
      m.priorityRank <= requestedRank ||
      minutesUntilStart(m.meetingDate, m.startTime, now) < BUMP_MIN_LEAD_MINUTES
  );

  if (blockers.length > 0) {
    return { state: "BOOKED", blockers };
  }

  if (overlaps.length > 0) {
    return { state: "BUMPABLE", victims: overlaps };
  }

  return { state: "FREE" };
}
