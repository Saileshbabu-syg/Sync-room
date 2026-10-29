import { eq } from "drizzle-orm";

import { db } from "@/db";
import { meetingTypes, roleMeetingTypes, roles } from "@/db/schema";
import type { DbExecutor } from "@/lib/db-types";

// Which meeting types a role may book is data (`role_meeting_types`, loaded by
// db/seed-priority.ts), not code — routes, the type picker and edit all ask
// this one service. A role with no rows may book nothing (fail closed).

export async function getAllowedMeetingTypes(
  roleName: string,
  executor: DbExecutor = db
) {
  const rows = await executor
    .select({
      meetingTypeId: meetingTypes.meetingTypeId,
      meetingTypeName: meetingTypes.meetingTypeName,
      priorityRank: meetingTypes.priorityRank,
    })
    .from(roleMeetingTypes)
    .innerJoin(roles, eq(roles.roleId, roleMeetingTypes.roleId))
    .innerJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, roleMeetingTypes.meetingTypeId)
    )
    .where(eq(roles.roleName, roleName));

  return rows.sort((a, b) => a.meetingTypeId - b.meetingTypeId);
}

export async function isMeetingTypeAllowedForRole(
  roleName: string,
  meetingTypeId: number,
  executor: DbExecutor = db
) {
  const allowed = await getAllowedMeetingTypes(roleName, executor);

  return allowed.some((t) => t.meetingTypeId === meetingTypeId);
}
