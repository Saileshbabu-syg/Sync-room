import { and, eq, inArray, sql } from "drizzle-orm";

import {
  employee,
  meeting,
  meeting_attendees,
  meetingTypes,
  roles,
} from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import type { Tx } from "@/lib/db-types";
import { isMeetingEnded } from "@/lib/time";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";
import { isMeetingTypeAllowed } from "./meeting-type-access.service";
import { requestOnlineSync } from "./online-meeting.service";
import { queueMeetingNotification } from "./notification.service";

// Editing the details of one meeting (title, headcount, meeting type,
// attendees). Used for a single meeting and for every occurrence a series edit
// touches, so both follow exactly the same rules. Date, time and room changes
// are moves (reschedule.service).

export class MeetingEditError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MeetingEditError";
    this.status = status;
  }
}

export type MeetingDetailsChange = {
  title?: string;
  participantCount?: number;
  meetingTypeId?: number;
  participantEmployeeIds?: number[];
  optionalParticipantEmployeeIds?: number[];
};

export type EditOutcome = {
  changes: string[];
  invitationIds: number[];
  titleChanged: boolean;
};

// Why this meeting cannot be edited any more, or null.
export function editBlocker(
  row: typeof meeting.$inferSelect,
  now?: Date
): string | null {
  if (row.meetingStatusId === MEETING_STATUS.COMPLETED) {
    return "Completed meetings cannot be edited.";
  }

  if (row.meetingStatusId === MEETING_STATUS.CANCELLED) {
    return "Cancelled meetings cannot be edited.";
  }

  if (row.meetingStatusId === MEETING_STATUS.PREEMPTED) {
    return "Replaced bookings cannot be edited. Please book a new slot.";
  }

  if (isMeetingEnded(row.meeting_date, row.start_time, row.end_time, now)) {
    return "Meetings that have already ended cannot be edited.";
  }

  return null;
}

// Applies `data` to one locked, editable meeting row inside the caller's
// transaction. Returns null when nothing would change. Does not queue the
// UPDATED notification (the caller does, once per meeting); does queue an
// invitation for each newly added participant. `note` is added to the audit
// remark (e.g. which part of a series the edit was for).
export async function applyMeetingEdit(
  tx: Tx,
  existingMeeting: typeof meeting.$inferSelect,
  data: MeetingDetailsChange,
  actorEmployeeId: number,
  note?: string
): Promise<EditOutcome | null> {
  const meetingId = existingMeeting.meeting_id;

  const existingRows = await tx
    .select({
      employee_id: meeting_attendees.employee_id,
      is_optional: meeting_attendees.is_optional,
    })
    .from(meeting_attendees)
    .where(eq(meeting_attendees.meeting_id, meetingId));

  const others = existingRows.filter(
    (a) => a.employee_id !== existingMeeting.organizerEmployeeId
  );
  const byId = (a: number, b: number) => a - b;

  // Existing attendees, organizer excluded, split by kind.
  const oldMandatory = others
    .filter((a) => !a.is_optional)
    .map((a) => a.employee_id)
    .sort(byId);
  const oldOptional = others
    .filter((a) => a.is_optional)
    .map((a) => a.employee_id)
    .sort(byId);
  const oldAttendees = [...oldMandatory, ...oldOptional].sort(byId);

  const newParticipantCount =
    data.participantCount ?? existingMeeting.participantCount;

  // Headcount above the room's capacity is allowed (the form only warns).

  // Attendees are only touched when the request supplies a list. If only
  // one of the two lists is sent, the other keeps its people - except
  // anyone just moved across, who can only be in one.
  const suppliedMandatory = data.participantEmployeeIds;
  const suppliedOptional = data.optionalParticipantEmployeeIds;
  const suppliedAttendees =
    suppliedMandatory !== undefined || suppliedOptional !== undefined;

  const clean = (ids: number[]) =>
    [...new Set(ids)]
      .filter((empId) => empId !== existingMeeting.organizerEmployeeId)
      .sort(byId);

  const newOptionalFirst =
    suppliedOptional !== undefined ? clean(suppliedOptional) : undefined;
  const newMandatory =
    suppliedMandatory !== undefined
      ? clean(suppliedMandatory)
      : oldMandatory.filter((id) => !newOptionalFirst?.includes(id));
  const newOptional =
    newOptionalFirst ?? oldOptional.filter((id) => !newMandatory.includes(id));

  const newAttendees = [...newMandatory, ...newOptional].sort(byId);

  // The organizer counts as one participant; the headcount can never be
  // lower than the people actually invited.
  if (newAttendees.length > newParticipantCount - 1) {
    throw new MeetingEditError(
      `You can add only ${newParticipantCount - 1} attendee(s). Organizer is counted automatically.`,
      400
    );
  }

  if (suppliedAttendees && newAttendees.length > 0) {
    const found = await tx
      .select({ id: employee.employee_id })
      .from(employee)
      .where(inArray(employee.employee_id, newAttendees));

    if (found.length !== newAttendees.length) {
      throw new MeetingEditError("One or more attendees not found.", 404);
    }
  }

  // Meeting type: must exist and be one the meeting owner's role may book.
  const typeChanged =
    data.meetingTypeId !== undefined &&
    data.meetingTypeId !== existingMeeting.meetingTypeId;

  if (typeChanged) {
    const [meetingType] = await tx
      .select({ id: meetingTypes.meetingTypeId })
      .from(meetingTypes)
      .where(eq(meetingTypes.meetingTypeId, data.meetingTypeId!));

    if (!meetingType) {
      throw new MeetingEditError("Meeting type not found.", 404);
    }

    const [owner] = await tx
      .select({ role: roles.roleName })
      .from(employee)
      .innerJoin(roles, eq(roles.roleId, employee.role_id))
      .where(eq(employee.employee_id, existingMeeting.organizerEmployeeId));

    if (
      !owner ||
      !(await isMeetingTypeAllowed(
        {
          employeeId: existingMeeting.organizerEmployeeId,
          roleName: owner.role,
        },
        data.meetingTypeId!,
        tx
      ))
    ) {
      throw new MeetingEditError(
        "The organizer's group is not allowed to use that meeting type.",
        403
      );
    }
  }

  // Only fields that were actually supplied are compared.
  const changes: string[] = [];

  if (data.title !== undefined && data.title !== existingMeeting.title) {
    changes.push("title");
  }

  if (newParticipantCount !== existingMeeting.participantCount) {
    changes.push("participantCount");
  }

  if (typeChanged) {
    changes.push("meetingType");
  }

  const membersChanged =
    suppliedAttendees &&
    JSON.stringify(oldAttendees) !== JSON.stringify(newAttendees);
  const kindsChanged =
    suppliedAttendees &&
    !membersChanged &&
    JSON.stringify(oldOptional) !== JSON.stringify(newOptional);
  const attendeesChanged = membersChanged || kindsChanged;

  if (membersChanged) {
    changes.push("attendees");
  }

  if (membersChanged || kindsChanged) {
    const moved =
      oldOptional.some((id) => newMandatory.includes(id)) ||
      oldMandatory.some((id) => newOptional.includes(id));

    if (moved) changes.push("participant types");
  }

  if (changes.length === 0) return null;

  await tx
    .update(meeting)
    .set({
      ...(data.title !== undefined && { title: data.title }),
      participantCount: newParticipantCount,
      ...(typeChanged && { meetingTypeId: data.meetingTypeId }),
      // A new title is a new version of the calendar entry; under the row
      // lock the caller holds, so concurrent edits each get their own version.
      ...(changes.includes("title") && {
        ics_sequence: sql`${meeting.ics_sequence} + 1`,
      }),
      updated_at: new Date(),
    })
    .where(eq(meeting.meeting_id, meetingId));

  // A new title goes to the Teams event too (background worker).
  if (changes.includes("title")) {
    await requestOnlineSync(tx, [meetingId]);
  }

  // Only the difference is written, so the people who stay keep the answer
  // they already gave; newly added participants get an invitation.
  const invitationIds: number[] = [];

  if (attendeesChanged) {
    const removed = oldAttendees.filter((id) => !newAttendees.includes(id));
    const added = newAttendees.filter((id) => !oldAttendees.includes(id));

    if (removed.length > 0) {
      await tx
        .delete(meeting_attendees)
        .where(
          and(
            eq(meeting_attendees.meeting_id, meetingId),
            inArray(meeting_attendees.employee_id, removed)
          )
        );
    }

    // Someone moved between the two lists keeps their answer; only the
    // kind changes.
    for (const [ids, isOptional] of [
      [newMandatory, false],
      [newOptional, true],
    ] as const) {
      const flip = ids.filter(
        (id) =>
          oldAttendees.includes(id) &&
          (isOptional ? oldMandatory : oldOptional).includes(id)
      );

      if (flip.length > 0) {
        await tx
          .update(meeting_attendees)
          .set({ is_optional: isOptional })
          .where(
            and(
              eq(meeting_attendees.meeting_id, meetingId),
              inArray(meeting_attendees.employee_id, flip)
            )
          );
      }
    }

    if (added.length > 0) {
      await tx.insert(meeting_attendees).values(
        added.map((employeeId) => ({
          meeting_id: meetingId,
          employee_id: employeeId,
          response_status: "NO_RESPONSE",
          is_optional: newOptional.includes(employeeId),
        }))
      );

      for (const employeeId of added) {
        invitationIds.push(
          await queueMeetingNotification(tx, meetingId, "INVITED", employeeId)
        );
      }
    }
  }

  await createAuditLog(
    meetingId,
    AUDIT_ACTION.UPDATED,
    `Updated: ${changes.join(", ")}${note ? ` (${note})` : ""}`,
    actorEmployeeId,
    tx
  );

  return {
    changes,
    invitationIds,
    titleChanged: changes.includes("title"),
  };
}
