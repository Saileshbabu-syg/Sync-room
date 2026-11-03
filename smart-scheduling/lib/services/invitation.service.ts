import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { employee, meeting, meeting_attendees, room } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { isMeetingEnded } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";

// Participants answer an e-mailed invitation once: ACCEPTED or DECLINED. The
// answer is stored on their meeting_attendees row. For a recurring series one
// answer covers every upcoming occurrence they were invited to.

export type InviteAction = "accept" | "decline";

export const RESPONSE = {
  NONE: "NO_RESPONSE",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
} as const;

export const RESPONSE_LABEL: Record<string, string> = {
  NO_RESPONSE: "No response",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
};

export type InvitationInfo = {
  meetingTitle: string;
  organizerName: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantName: string;
  response: string;
  // Why an answer cannot be given any more (cancelled, over, ...), if so.
  closedReason: string | null;
};

function closedReason(statusId: number, date: string, endTime: string) {
  if (statusId === MEETING_STATUS.CANCELLED) return "This meeting was cancelled.";
  if (statusId === MEETING_STATUS.PREEMPTED) {
    return "This booking was replaced by a higher-priority booking and no longer holds the room.";
  }
  if (statusId === MEETING_STATUS.PENDING_RESCHEDULE) {
    return "This meeting is waiting to be rescheduled.";
  }
  if (statusId === MEETING_STATUS.COMPLETED || isMeetingEnded(date, endTime)) {
    return "This meeting is over.";
  }

  return null;
}

// Details for the confirmation page. Null when the person is not invited.
export async function getInvitationInfo(
  meetingId: number,
  employeeId: number
): Promise<InvitationInfo | null> {
  const [row] = await db
    .select({
      title: meeting.title,
      date: meeting.meeting_date,
      start: meeting.start_time,
      end: meeting.end_time,
      statusId: meeting.meetingStatusId,
      roomName: room.room_name,
      organizerId: meeting.organizerEmployeeId,
      response: meeting_attendees.response_status,
      participant: employee.employee_name,
    })
    .from(meeting_attendees)
    .innerJoin(meeting, eq(meeting.meeting_id, meeting_attendees.meeting_id))
    .innerJoin(room, eq(room.room_id, meeting.room_id))
    .innerJoin(
      employee,
      eq(employee.employee_id, meeting_attendees.employee_id)
    )
    .where(
      and(
        eq(meeting_attendees.meeting_id, meetingId),
        eq(meeting_attendees.employee_id, employeeId)
      )
    );

  if (!row) return null;

  const [organizer] = await db
    .select({ name: employee.employee_name })
    .from(employee)
    .where(eq(employee.employee_id, row.organizerId));

  return {
    meetingTitle: row.title,
    organizerName: organizer?.name ?? "",
    roomName: row.roomName,
    meetingDate: row.date,
    startTime: row.start,
    endTime: row.end,
    participantName: row.participant,
    response: row.response,
    closedReason: closedReason(row.statusId, row.date, row.end),
  };
}

export type RespondResult =
  | { status: "recorded"; response: string }
  // They already answered; the first answer stands.
  | { status: "already"; response: string }
  | { status: "closed"; reason: string }
  | { status: "not-found" };

// Records the answer exactly once. The conditional UPDATE is the guard, so two
// simultaneous clicks (or both buttons) can never both win.
export async function respondToInvitation(
  meetingId: number,
  employeeId: number,
  action: InviteAction
): Promise<RespondResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        statusId: meeting.meetingStatusId,
        date: meeting.meeting_date,
        end: meeting.end_time,
        seriesId: meeting.recurringMeetingId,
        response: meeting_attendees.response_status,
      })
      .from(meeting_attendees)
      .innerJoin(meeting, eq(meeting.meeting_id, meeting_attendees.meeting_id))
      .where(
        and(
          eq(meeting_attendees.meeting_id, meetingId),
          eq(meeting_attendees.employee_id, employeeId)
        )
      )
      .for("update", { of: meeting_attendees });

    if (!row) return { status: "not-found" as const };

    if (row.response !== RESPONSE.NONE) {
      return { status: "already" as const, response: row.response };
    }

    const reason = closedReason(row.statusId, row.date, row.end);

    if (reason) return { status: "closed" as const, reason };

    const response =
      action === "accept" ? RESPONSE.ACCEPTED : RESPONSE.DECLINED;

    const updated = await tx
      .update(meeting_attendees)
      .set({ response_status: response, responded_at: new Date() })
      .where(
        and(
          eq(meeting_attendees.meeting_id, meetingId),
          eq(meeting_attendees.employee_id, employeeId),
          eq(meeting_attendees.response_status, RESPONSE.NONE)
        )
      )
      .returning({ id: meeting_attendees.meeting_attendee_id });

    // Lost a race with another answer.
    if (updated.length === 0) {
      return { status: "already" as const, response: row.response };
    }

    // One answer covers the rest of a recurring series.
    if (row.seriesId !== null) {
      const siblings = await tx
        .select({ id: meeting.meeting_id })
        .from(meeting)
        .where(
          and(
            eq(meeting.recurringMeetingId, row.seriesId),
            eq(meeting.meetingStatusId, MEETING_STATUS.SCHEDULED)
          )
        );

      for (const { id } of siblings) {
        if (id === meetingId) continue;

        await tx
          .update(meeting_attendees)
          .set({ response_status: response, responded_at: new Date() })
          .where(
            and(
              eq(meeting_attendees.meeting_id, id),
              eq(meeting_attendees.employee_id, employeeId),
              eq(meeting_attendees.response_status, RESPONSE.NONE)
            )
          );
      }
    }

    await createAuditLog(
      meetingId,
      action === "accept"
        ? AUDIT_ACTION.INVITE_ACCEPTED
        : AUDIT_ACTION.INVITE_DECLINED,
      `Participant ${action === "accept" ? "accepted" : "declined"} the invitation`,
      employeeId,
      tx
    );

    return { status: "recorded" as const, response };
  });
}
