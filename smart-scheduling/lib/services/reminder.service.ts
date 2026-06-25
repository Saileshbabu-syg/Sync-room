import { db } from "@/db";

import { reminder_logs } from "@/db/schema/reminder_logs";
import { notifications } from "@/db/schema/notifications";
import { meeting_attendees } from "@/db/schema/meeting_attendees";
import { employee } from "@/db/schema/Employee";
import { meeting } from "@/db/schema/meeting";

import { and, eq, lte } from "drizzle-orm";

// export async function getPendingReminders() {
//     console.log("Current Node Time:", new Date());
//   return await db
//     .select()
//     .from(reminder_logs)
//     .where(
//       and(
//         eq(reminder_logs.status, "PENDING"),
//         lte(reminder_logs.reminder_time, new Date())
//       )
//     );
// }

export async function getPendingReminders() {
  return await db
    .select()
    .from(reminder_logs)
    .where(
      eq(reminder_logs.status, "PENDING")
    );
}

export async function getMeetingAttendees(
  meetingId: number
) {
  return await db
    .select({
      email: employee.email,
      employee_name: employee.employee_name,
    })
    .from(meeting_attendees)
    .innerJoin(
      employee,
      eq(
        meeting_attendees.employee_id,
        employee.employee_id
      )
    )
    .where(
      eq(
        meeting_attendees.meeting_id,
        meetingId
      )
    );
}

export async function getMeetingDetails(
  meetingId: number
) {
  const result = await db
    .select()
    .from(meeting)
    .where(
      eq(
        meeting.meeting_id,
        meetingId
      )
    );

  return result[0];
}

export async function markReminderAsSent(
  reminderLogId: number
) {
  await db
    .update(reminder_logs)
    .set({
      status: "SENT",
    })
    .where(
      eq(
        reminder_logs.reminder_log_id,
        reminderLogId
      )
    );
}

export async function markNotificationAsSent(
  meetingId: number
) {
  await db
    .update(notifications)
    .set({
      status: "SENT",
      sent_at: new Date(),
    })
    .where(
      eq(
        notifications.meeting_id,
        meetingId
      )
    );
}