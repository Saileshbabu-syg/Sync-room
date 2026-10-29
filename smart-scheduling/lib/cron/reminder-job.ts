import cron from "node-cron";

import { updateCompletedMeetings } from "@/lib/services/meeting-status.service";
import { processPendingNotifications } from "@/lib/services/notification.service";
import { processDueReminders } from "@/lib/services/reminder.service";

// One tick: mark finished meetings, send due reminders, retry undelivered
// booking e-mails. Exported so it can be run (and tested) without the timer.
//
// Every step claims its rows with FOR UPDATE SKIP LOCKED, so several server
// instances (or Next.js workers) each running this job do not send anything
// twice.
export async function runReminderTick() {
  const completed = await updateCompletedMeetings();
  const reminders = await processDueReminders();
  const notifications = await processPendingNotifications();

  return { completed, reminders, notifications };
}

const globalForCron = globalThis as typeof globalThis & {
  __reminderCronStarted?: boolean;
};

// Set REMINDER_CRON_ENABLED=false to run an instance without the scheduler
// (e.g. extra web replicas, or tests).
if (
  process.env.REMINDER_CRON_ENABLED !== "false" &&
  !globalForCron.__reminderCronStarted
) {
  globalForCron.__reminderCronStarted = true;

  cron.schedule("* * * * *", async () => {
    try {
      const result = await runReminderTick();

      if (
        result.completed > 0 ||
        result.reminders.sent > 0 ||
        result.notifications.SENT > 0
      ) {
        console.log("Reminder cron:", JSON.stringify(result));
      }
    } catch (error) {
      console.error("Reminder Cron Error:", error);
    }
  });
}

export {};
