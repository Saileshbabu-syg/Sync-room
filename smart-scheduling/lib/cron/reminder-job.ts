import cron from "node-cron";

import {
  getPendingReminders,
  getMeetingAttendees,
  getMeetingDetails,
  markReminderAsSent,
  markNotificationAsSent,
} from "@/lib/services/reminder.service";

import {updateCompletedMeetings} from "@/lib/services/meeting-status.service"

import { sendMeetingEmail } from "@/lib/services/email.service";

cron.schedule("* * * * *", async () => {
  try {
    console.log("Checking pending reminders...");

    // Update completed meetings
    const updatedMeetings =
      await updateCompletedMeetings();

    if (updatedMeetings > 0) {
      console.log(
        `${updatedMeetings} meeting(s) marked as Completed.`
      );
    }

    const reminders =
      await getPendingReminders();

    console.log(
      "Reminders Found:",
      reminders.length
    );

    for (const reminder of reminders) {

      const now = new Date(
        new Date().toLocaleString(
          "en-US",
          {
            timeZone: "Asia/Kolkata",
          }
        )
      );

      const reminderTime = new Date(
        new Date(
          reminder.reminder_time
        ).toLocaleString(
          "en-US",
          {
            timeZone:
              "Asia/Kolkata",
          }
        )
      );

      console.log(
        "Current Time:",
        new Date().toLocaleString(
          "en-IN",
          {
            timeZone:
              "Asia/Kolkata",
          }
        )
      );

      console.log(
        "Reminder Time:",
        reminderTime.toLocaleString(
          "en-IN",
          {
            timeZone:
              "Asia/Kolkata",
          }
        )
      );

      if (reminderTime > now) {

        console.log(
          `Skipping reminder ${reminder.reminder_log_id}`
        );

        continue;

      }

      const attendees =
        await getMeetingAttendees(
          reminder.meeting_id
        );

      const meetingDetails =
        await getMeetingDetails(
          reminder.meeting_id
        );

      if (!meetingDetails) {
        continue;
      }

      for (const attendee of attendees) {

        if (!attendee.email) {
          continue;
        }

        console.log(
          `Sending mail to ${attendee.email}`
        );

        await sendMeetingEmail(
          attendee.email,
          meetingDetails.title,
          String(
            meetingDetails.meeting_date
          ),
          String(
            meetingDetails.start_time
          ),
          String(
            meetingDetails.end_time
          )
        );

      }

      await markReminderAsSent(
        reminder.reminder_log_id
      );

      await markNotificationAsSent(
        reminder.meeting_id
      );

      console.log(
        `Reminder sent for meeting ${reminder.meeting_id}`
      );

    }

    console.log("Cron Completed");

    console.log("--------------------------------");

  } catch (error) {

    console.error(
      "Reminder Cron Error:",
      error
    );

  }
});

export {};