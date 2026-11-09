import { db } from "@/db";
import { meeting_audit_logs } from "@/db/schema";
import type { DbExecutor } from "@/lib/db-types";

export const AUDIT_ACTION = {
  CREATED: "MEETING_CREATED",
  UPDATED: "MEETING_UPDATED",
  CANCELLED: "MEETING_CANCELLED",
  COMPLETED: "MEETING_COMPLETED",
  BUMPED_PENDING: "MEETING_BUMPED_PENDING",
  RESCHEDULED: "MEETING_RESCHEDULED",
  BUMPED_MOVED: "MEETING_BUMPED_MOVED",
  BUMPED_CANCELLED: "MEETING_BUMPED_CANCELLED",
  PREEMPTED: "MEETING_PREEMPTED",
  INVITE_ACCEPTED: "INVITATION_ACCEPTED",
  INVITE_DECLINED: "INVITATION_DECLINED",
  REMINDER_SENT: "REMINDER_SENT",
  // An administrator put a FAILED notification or reminder back in the queue.
  EMAIL_REQUEUED: "EMAIL_REQUEUED",
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
