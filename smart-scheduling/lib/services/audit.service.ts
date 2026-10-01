import { db } from "@/db";

import { meeting_audit_logs }
from "@/db/schema";

export async function createAuditLog(
  meetingId: number,
  action: string,
  remarks?: string
) {
  await db
    .insert(meeting_audit_logs)
    .values({
      meeting_id: meetingId,
      action,
      remarks,
    });
}