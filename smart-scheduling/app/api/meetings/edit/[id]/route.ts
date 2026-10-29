import { NextRequest, NextResponse } from "next/server";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";

import {
  employee,
  meeting,
  meeting_attendees,
  meetingTypes,
  room,
  roles,
} from "@/db/schema";

import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import {
  guardMutation,
  jsonError,
  parseIdParam,
  rateLimit,
  readJson,
} from "@/lib/api";
import { MEETING_STATUS, ROLE_ADMIN } from "@/lib/constants";
import { isMeetingEnded } from "@/lib/time";
import { AUDIT_ACTION, createAuditLog } from "@/lib/services/audit.service";
import { isMeetingTypeAllowedForRole } from "@/lib/services/meeting-type-access.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "@/lib/services/notification.service";

class EditError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  }
) {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const blocked =
      guardMutation(req) ?? rateLimit(organizer.employeeId, "edit", 30);

    if (blocked) return blocked;

    const { id } = await params;

    const meetingId = parseIdParam(id);

    if (meetingId === null) {
      return jsonError(400, "Invalid meeting id.");
    }

    const body = await readJson(req);

    if (!body.ok) return body.response;

    const result = editMeetingSchema.safeParse(body.data);

    if (!result.success) {
      return NextResponse.json(
        {
          message: "Validation failed",
          errors: result.error.issues,
        },
        {
          status: 400,
        }
      );
    }

    const validatedData = result.data;

    const notificationId = await db.transaction(async (tx) => {
      // Lock the meeting row so concurrent edits/cancels are serialised.
      const [existingMeeting] = await tx
        .select()
        .from(meeting)
        .where(eq(meeting.meeting_id, meetingId))
        .for("update");

      if (!existingMeeting) {
        throw new EditError("Meeting not found.", 404);
      }

      // Only the organizer or an Admin (current role) may edit a meeting.
      if (
        existingMeeting.organizerEmployeeId !== organizer.employeeId &&
        organizer.role !== ROLE_ADMIN
      ) {
        throw new EditError(
          "You do not have permission to edit this meeting.",
          403
        );
      }

      // Only Scheduled meetings can be edited
      if (existingMeeting.meetingStatusId === MEETING_STATUS.COMPLETED) {
        throw new EditError("Completed meetings cannot be edited.", 400);
      }

      if (existingMeeting.meetingStatusId === MEETING_STATUS.CANCELLED) {
        throw new EditError("Cancelled meetings cannot be edited.", 400);
      }

      if (
        isMeetingEnded(existingMeeting.meeting_date, existingMeeting.end_time)
      ) {
        throw new EditError(
          "Meetings that have already ended cannot be edited.",
          400
        );
      }

      const [roomDetails] = await tx
        .select()
        .from(room)
        .where(eq(room.room_id, existingMeeting.room_id));

      if (!roomDetails) {
        throw new EditError("Room not found.", 404);
      }

      const existingRows = await tx
        .select({ employee_id: meeting_attendees.employee_id })
        .from(meeting_attendees)
        .where(eq(meeting_attendees.meeting_id, meetingId));

      // Existing attendees, organizer excluded.
      const oldAttendees = existingRows
        .map((a) => a.employee_id)
        .filter((empId) => empId !== existingMeeting.organizerEmployeeId)
        .sort((a, b) => a - b);

      const newParticipantCount =
        validatedData.participantCount ?? existingMeeting.participantCount;

      if (newParticipantCount > roomDetails.room_capacity) {
        throw new EditError("Room capacity exceeded.", 400);
      }

      // Attendees are only touched when the request supplies them.
      const suppliedAttendees = validatedData.participantEmployeeIds;

      const newAttendees =
        suppliedAttendees !== undefined
          ? [...new Set(suppliedAttendees)]
              .filter((empId) => empId !== existingMeeting.organizerEmployeeId)
              .sort((a, b) => a - b)
          : oldAttendees;

      // The organizer counts as one participant; the headcount can never be
      // lower than the people actually invited.
      if (newAttendees.length > newParticipantCount - 1) {
        throw new EditError(
          `You can add only ${newParticipantCount - 1} attendee(s). Organizer is counted automatically.`,
          400
        );
      }

      if (suppliedAttendees !== undefined && newAttendees.length > 0) {
        const found = await tx
          .select({ id: employee.employee_id })
          .from(employee)
          .where(inArray(employee.employee_id, newAttendees));

        if (found.length !== newAttendees.length) {
          throw new EditError("One or more attendees not found.", 404);
        }
      }

      // Meeting type: must exist and be one the meeting owner's role may book.
      const typeChanged =
        validatedData.meetingTypeId !== undefined &&
        validatedData.meetingTypeId !== existingMeeting.meetingTypeId;

      if (typeChanged) {
        const [meetingType] = await tx
          .select({ id: meetingTypes.meetingTypeId })
          .from(meetingTypes)
          .where(eq(meetingTypes.meetingTypeId, validatedData.meetingTypeId!));

        if (!meetingType) {
          throw new EditError("Meeting type not found.", 404);
        }

        const [owner] = await tx
          .select({ role: roles.roleName })
          .from(employee)
          .innerJoin(roles, eq(roles.roleId, employee.role_id))
          .where(eq(employee.employee_id, existingMeeting.organizerEmployeeId));

        if (
          !owner ||
          !(await isMeetingTypeAllowedForRole(
            owner.role,
            validatedData.meetingTypeId!,
            tx
          ))
        ) {
          throw new EditError(
            "This role is not allowed to use that meeting type.",
            403
          );
        }
      }

      // Only fields that were actually supplied are compared.
      const changes: string[] = [];

      if (
        validatedData.title !== undefined &&
        validatedData.title !== existingMeeting.title
      ) {
        changes.push("title");
      }

      if (newParticipantCount !== existingMeeting.participantCount) {
        changes.push("participantCount");
      }

      if (typeChanged) {
        changes.push("meetingType");
      }

      const attendeesChanged =
        suppliedAttendees !== undefined &&
        JSON.stringify(oldAttendees) !== JSON.stringify(newAttendees);

      if (attendeesChanged) {
        changes.push("attendees");
      }

      if (changes.length === 0) {
        throw new EditError("No changes detected.", 400);
      }

      await tx
        .update(meeting)
        .set({
          ...(validatedData.title !== undefined && {
            title: validatedData.title,
          }),
          participantCount: newParticipantCount,
          ...(typeChanged && {
            meetingTypeId: validatedData.meetingTypeId,
          }),
          updated_at: new Date(),
        })
        .where(eq(meeting.meeting_id, meetingId));

      if (attendeesChanged) {
        await tx
          .delete(meeting_attendees)
          .where(
            and(
              eq(meeting_attendees.meeting_id, meetingId)
            )
          );

        await tx.insert(meeting_attendees).values(
          [existingMeeting.organizerEmployeeId, ...newAttendees].map(
            (employeeId) => ({
              meeting_id: meetingId,
              employee_id: employeeId,
            })
          )
        );
      }

      await createAuditLog(
        meetingId,
        AUDIT_ACTION.UPDATED,
        `Updated: ${changes.join(", ")}`,
        organizer.employeeId,
        tx
      );

      return queueMeetingNotification(tx, meetingId, "UPDATED");
    });

    dispatchNotification(notificationId);

    return NextResponse.json(
      {
        success: true,
        message: "Meeting updated successfully.",
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    if (error instanceof EditError) {
      return jsonError(error.status, error.message);
    }

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
