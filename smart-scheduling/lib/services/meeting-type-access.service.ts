import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import {
  groupMeetingTypes,
  groups,
  meetingTypes,
  roleMeetingTypes,
  roles,
  userGroups,
} from "@/db/schema";
import type { DbExecutor } from "@/lib/db-types";

// Which meeting types a person may book.
//
//  * Someone in an active group gets the types ticked for that group
//    (`group_meeting_types`, edited on the Group Management screen). A group
//    with none ticked may book nothing (fail closed).
//  * Someone with no usable group (none, or a deactivated one) falls back to the
//    list for their role (`role_meeting_types`, loaded by db/seed-priority.ts),
//    exactly as before groups existed.
//
// Routes, the type picker and edit all ask this one service, so the frontend and
// the backend can never disagree.
//
// `priorityRank` is the type's own rank (1 = highest). Inviting Leadership
// outranks every type; booking.service decides that.

export type MeetingTypeSubject = {
  employeeId: number;
  roleName: string;
};

async function activeGroupId(employeeId: number, executor: DbExecutor) {
  const [row] = await executor
    .select({ groupId: groups.id })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(
      and(
        eq(userGroups.employeeId, employeeId),
        isNull(userGroups.effectiveUntil),
        eq(groups.isActive, true)
      )
    );

  return row?.groupId ?? null;
}

export async function getAllowedMeetingTypes(
  { employeeId, roleName }: MeetingTypeSubject,
  executor: DbExecutor = db
) {
  const groupId = await activeGroupId(employeeId, executor);

  const rows =
    groupId !== null
      ? await executor
          .select({
            meetingTypeId: meetingTypes.meetingTypeId,
            meetingTypeName: meetingTypes.meetingTypeName,
            typeRank: meetingTypes.priorityRank,
          })
          .from(groupMeetingTypes)
          .innerJoin(
            meetingTypes,
            eq(meetingTypes.meetingTypeId, groupMeetingTypes.meetingTypeId)
          )
          .where(eq(groupMeetingTypes.groupId, groupId))
      : await executor
          .select({
            meetingTypeId: meetingTypes.meetingTypeId,
            meetingTypeName: meetingTypes.meetingTypeName,
            typeRank: meetingTypes.priorityRank,
          })
          .from(roleMeetingTypes)
          .innerJoin(roles, eq(roles.roleId, roleMeetingTypes.roleId))
          .innerJoin(
            meetingTypes,
            eq(meetingTypes.meetingTypeId, roleMeetingTypes.meetingTypeId)
          )
          .where(eq(roles.roleName, roleName));

  return rows
    .map(({ typeRank, ...type }) => ({ ...type, priorityRank: typeRank }))
    .sort((a, b) => a.meetingTypeId - b.meetingTypeId);
}

export async function isMeetingTypeAllowed(
  subject: MeetingTypeSubject,
  meetingTypeId: number,
  executor: DbExecutor = db
) {
  const allowed = await getAllowedMeetingTypes(subject, executor);

  return allowed.some((t) => t.meetingTypeId === meetingTypeId);
}
