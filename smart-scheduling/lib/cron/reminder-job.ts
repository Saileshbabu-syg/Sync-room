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

type Tick = typeof runReminderTick;
type Schedule = (expression: string, task: () => Promise<void>) => unknown;

const globalForCron = globalThis as typeof globalThis & {
  __reminderCronStarted?: boolean;
};

// Starts the per-minute scheduler in this process. Called once from
// instrumentation.ts when the server boots. Returns false when it did not
// start (disabled with REMINDER_CRON_ENABLED=false, or already started in this
// process).
//
// - A tick that is still running when the next minute arrives is skipped, so a
//   slow mail relay cannot pile up overlapping ticks in one process.
// - A failing tick (e.g. the database is down) is logged and the schedule
//   keeps running; it never throws into the server.
// - Only a message is logged, never the error object, which can carry
//   connection details.
export function startReminderScheduler({
  schedule = (expression, task) => cron.schedule(expression, task),
  tick = runReminderTick,
  env = process.env,
}: { schedule?: Schedule; tick?: Tick; env?: Record<string, string | undefined> } = {}) {
  if (env.REMINDER_CRON_ENABLED === "false") {
    console.log("Reminder scheduler is disabled (REMINDER_CRON_ENABLED=false).");
    return false;
  }

  if (globalForCron.__reminderCronStarted) return false;

  globalForCron.__reminderCronStarted = true;

  let running = false;

  console.log("Reminder scheduler started: running every minute.");

  schedule("* * * * *", async () => {
    if (running) return;

    running = true;

    try {
      const result = await tick();

      if (
        result.completed > 0 ||
        result.reminders.sent > 0 ||
        result.notifications.SENT > 0
      ) {
        console.log("Reminder cron:", JSON.stringify(result));
      }
    } catch (error) {
      console.error(
        "Reminder Cron Error:",
        error instanceof Error ? error.message : "unknown error"
      );
    } finally {
      running = false;
    }
  });

  return true;
}

// Test hook: forget that this process started the scheduler.
export function resetReminderSchedulerForTests() {
  globalForCron.__reminderCronStarted = false;
}
