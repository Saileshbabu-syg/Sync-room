import { db } from "@/db";
import { meeting_audit_logs } from "@/db/schema";
import type { DbExecutor } from "@/lib/db-types";

export const AUDIT_ACTION = {
  CREATED: "MEETING_CREATED",
  UPDATED: "MEETING_UPDATED",
  CANCELLED: "MEETING_CANCELLED",
  COMPLETED: "MEETING_COMPLETED",
  REMINDER_SENT: "REMINDER_SENT",
} as const;

// Pass the caller's transaction as `executor` so the audit row commits (or
// rolls back) together with the change it describes.
export async function createAuditLog(
  meetingId: number,
  action: string,
  remarks?: string,
  actorEmployeeId?: number | null,
  executor: DbExecutor = db
) {
  await executor.insert(meeting_audit_logs).values({
    meeting_id: meetingId,
    action,
    remarks: remarks?.slice(0, 255),
    actor_employee_id: actorEmployeeId ?? null,
  });
}
