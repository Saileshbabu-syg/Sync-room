import cron from "node-cron";

import {
  getPendingReminders,
  getMeetingAttendees,
  getMeetingDetails,
  markReminderAsSent,
  markNotificationAsSent,
} from "@/lib/services/reminder.service";

import { sendMeetingEmail } from "@/lib/services/email.service";


cron.schedule("* * * * *", async () => {
  try {
    console.log("Checking pending reminders...");

    const reminders = await getPendingReminders();

    

    console.log(
      "Reminders Found:",
      reminders.length
    );

    for (const reminder of reminders) {
      const now = new Date(
  new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
  })
);

const reminderTime = new Date(
  new Date(reminder.reminder_time).toLocaleString(
    "en-US",
    {
      timeZone: "Asia/Kolkata",
    }
  )
);

console.log(
  "Current Time:",
  new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  })
);

console.log(
  "Reminder Time:",
  reminderTime.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  })
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

      console.log(
        "Attendees:",
        attendees
      );

      const meetingDetails =
        await getMeetingDetails(
          reminder.meeting_id
        );

      console.log(
        "Meeting Details:",
        meetingDetails
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
  } catch (error) {
    console.error(
      "Reminder Cron Error:",
      error
    );
  }
});

export {};