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
import { isMeetingTypeAllowed } from "@/lib/services/meeting-type-access.service";
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

      if (existingMeeting.meetingStatusId === MEETING_STATUS.PREEMPTED) {
        throw new EditError(
          "Replaced bookings cannot be edited. Please book a new slot.",
          400
        );
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
        validatedData.participantCount ?? existingMeeting.participantCount;

      // Headcount above the room's capacity is allowed (the form only warns).

      // Attendees are only touched when the request supplies a list. If only
      // one of the two lists is sent, the other keeps its people - except
      // anyone just moved across, who can only be in one.
      const suppliedMandatory = validatedData.participantEmployeeIds;
      const suppliedOptional = validatedData.optionalParticipantEmployeeIds;
      const suppliedAttendees =
        suppliedMandatory !== undefined || suppliedOptional !== undefined
          ? true
          : undefined;

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
        throw new EditError(
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
          !(await isMeetingTypeAllowed(
            {
              employeeId: existingMeeting.organizerEmployeeId,
              roleName: owner.role,
            },
            validatedData.meetingTypeId!,
            tx
          ))
        ) {
          throw new EditError(
            "The organizer's group is not allowed to use that meeting type.",
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

      const membersChanged =
        suppliedAttendees === true &&
        JSON.stringify(oldAttendees) !== JSON.stringify(newAttendees);
      const kindsChanged =
        suppliedAttendees === true &&
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
            (id) => oldAttendees.includes(id) && (isOptional ? oldMandatory : oldOptional).includes(id)
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
              await queueMeetingNotification(
                tx,
                meetingId,
                "INVITED",
                employeeId
              )
            );
          }
        }
      }

      await createAuditLog(
        meetingId,
        AUDIT_ACTION.UPDATED,
        `Updated: ${changes.join(", ")}`,
        organizer.employeeId,
        tx
      );

      return {
        updateId: await queueMeetingNotification(tx, meetingId, "UPDATED"),
        invitationIds,
      };
    });

    dispatchNotification(notificationId.updateId);

    for (const id of notificationId.invitationIds) dispatchNotification(id);

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
