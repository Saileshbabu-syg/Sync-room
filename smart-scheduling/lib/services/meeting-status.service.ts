import { db } from "@/db";
import { meeting } from "@/db/schema";

import {
  and,
  eq,
  sql,
} from "drizzle-orm";

export async function updateCompletedMeetings() {
  try {
    const updatedMeetings = await db
      .update(meeting)
      .set({
        meetingStatusId: 2, // Completed
        updated_at: new Date(),
      })
      .where(
        and(
          eq(meeting.meetingStatusId, 1),
          sql`(
            (${meeting.meeting_date} + ${meeting.end_time})
          ) <= NOW()`
        )
      )
      .returning({
        meetingId: meeting.meeting_id,
      });

    return updatedMeetings.length;
  } catch (error) {
    console.error(
      "Meeting Status Update Error:",
      error
    );

    return 0;
  }
}