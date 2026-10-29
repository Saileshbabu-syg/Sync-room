import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting } from "@/db/schema";
import { APP_TIMEZONE, MEETING_STATUS } from "@/lib/constants";

import { AUDIT_ACTION, createAuditLog } from "./audit.service";

export async function updateCompletedMeetings() {
  try {
    return await db.transaction(async (tx) => {
      // Meeting date + end time are wall-clock values in APP_TIMEZONE, so they
      // must be converted to an instant before comparing with now().
      const updatedMeetings = await tx
        .update(meeting)
        .set({
          meetingStatusId: MEETING_STATUS.COMPLETED,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(meeting.meetingStatusId, MEETING_STATUS.SCHEDULED),
            sql`(
              (${meeting.meeting_date} + ${meeting.end_time})
                AT TIME ZONE ${APP_TIMEZONE}
            ) <= NOW()`
          )
        )
        .returning({
          meetingId: meeting.meeting_id,
        });

      for (const { meetingId } of updatedMeetings) {
        await createAuditLog(
          meetingId,
          AUDIT_ACTION.COMPLETED,
          "Marked completed after its end time",
          null,
          tx
        );
      }

      return updatedMeetings.length;
    });
  } catch (error) {
    console.error("Meeting Status Update Error:", error);

    return 0;
  }
}
