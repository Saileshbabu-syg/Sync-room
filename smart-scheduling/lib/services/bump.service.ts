import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { meeting, meetingTypes } from "@/db/schema";
import type { DbExecutor } from "@/lib/db-types";

import { BookingError } from "./booking-error";
import { holdsSlot, overlapsSlot } from "./conflict-check.service";
import {
  classifySlot,
  type OverlappingMeeting,
  type SlotState,
} from "./priority.service";

export type PreviewInput = {
  roomId: number;
  meetingDate: string;
  startTime: string;
  endTime: string;
  meetingTypeId: number;
  // Test hook.
  now?: Date;
};

// The meetings currently holding any part of the slot, with the priority rank
// of their type. Cancelled and PENDING_ROOM meetings hold nothing.
export async function findOverlappingMeetings(
  executor: DbExecutor,
  input: Pick<
    PreviewInput,
    "roomId" | "meetingDate" | "startTime" | "endTime"
  >
): Promise<OverlappingMeeting[]> {
  return executor
    .select({
      meetingId: meeting.meeting_id,
      priorityRank: meetingTypes.priorityRank,
      statusId: meeting.meetingStatusId,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
    })
    .from(meeting)
    .innerJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, meeting.meetingTypeId)
    )
    .where(
      and(
        eq(meeting.room_id, input.roomId),
        eq(meeting.meeting_date, input.meetingDate),
        holdsSlot,
        overlapsSlot(input.startTime, input.endTime)
      )
    );
}

// Read-only answer to "what would happen if I booked this slot with this
// meeting type?". Used by the room list and the confirm dialog; the booking
// itself re-decides inside its own locked transaction.
export async function previewBooking(
  input: PreviewInput,
  executor: DbExecutor = db
): Promise<SlotState> {
  const [type] = await executor
    .select({ rank: meetingTypes.priorityRank })
    .from(meetingTypes)
    .where(eq(meetingTypes.meetingTypeId, input.meetingTypeId));

  if (!type) {
    throw new BookingError("Meeting type not found", 404);
  }

  const overlaps = await findOverlappingMeetings(executor, input);

  return classifySlot(type.rank, overlaps, input.now ?? new Date());
}
