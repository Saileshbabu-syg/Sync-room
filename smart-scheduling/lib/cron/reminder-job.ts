import cron from "node-cron";

import { updateCompletedMeetings } from "@/lib/services/meeting-status.service";
import { processPendingNotifications } from "@/lib/services/notification.service";
import { processExpiredBumps } from "@/lib/services/priority.service";
import { runScheduledSync } from "@/lib/services/entra-sync.service";
import {
  cleanupOnlineMeetings,
  processOnlineMeetings,
} from "@/lib/services/online-meeting.service";
import { processDueReminders } from "@/lib/services/reminder.service";

// The work of one tick, in order. Injectable so a test can make a step fail.
export const TICK_STEPS = {
  processExpiredBumps,
  // Deletes the Teams events of cancelled / replaced / expired meetings
  // (including any a previous attempt could not remove).
  cleanupOnlineMeetings: () => cleanupOnlineMeetings(),
  // Creates / updates Teams events (before the e-mail step, so e-mails waiting
  // for a link can go out in the same tick).
  processOnlineMeetings: () => processOnlineMeetings(),
  updateCompletedMeetings,
  processDueReminders: () => processDueReminders(),
  processPendingNotifications: () => processPendingNotifications(),
  runScheduledSync: () => runScheduledSync(),
};

type Steps = typeof TICK_STEPS;

// Runs one step on its own: a failure is logged with the step's name and the
// tick carries on with the next step (the step's result is then the fallback).
// Only the message is logged, never the error object, which can carry
// connection details.
async function runStep<T>(name: string, step: () => Promise<T>, fallback: T) {
  try {
    return await step();
  } catch (error) {
    console.error(
      `Cron step "${name}" failed:`,
      error instanceof Error ? error.message : "unknown error"
    );

    return fallback;
  }
}

// One tick: cancel bumped meetings nobody rescheduled in time, remove stale
// Teams events, mark finished meetings, send due reminders and retry
// undelivered booking e-mails. Exported so it can be run (and tested) without
// the timer.
//
// Each step is isolated: one that throws (a bad row, a database hiccup) is
// logged and the remaining steps still run, so for example a failing bump
// sweep can never hold up reminders. Every step claims its rows
// (FOR UPDATE SKIP LOCKED / leases), so several server instances (or Next.js
// workers) each running this job do not send anything twice.
export async function runReminderTick(steps: Steps = TICK_STEPS) {
  const expiredBumps = await runStep("expired bumps", steps.processExpiredBumps, 0);
  const onlineCleanup = await runStep(
    "Teams event cleanup",
    steps.cleanupOnlineMeetings,
    0
  );
  const online = await runStep("Teams provisioning", steps.processOnlineMeetings, {
    READY: 0,
    STALE: 0,
    RETRY: 0,
    FAILED: 0,
    SKIPPED: 0,
  });
  const completed = await runStep(
    "completed meetings",
    steps.updateCompletedMeetings,
    0
  );
  const reminders = await runStep("reminders", steps.processDueReminders, {
    sent: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
  });
  const notifications = await runStep(
    "notification retries",
    steps.processPendingNotifications,
    { SENT: 0, RETRY: 0, FAILED: 0, SKIPPED: 0 }
  );

  // Automatic Entra ID sync, when an admin turned it on. Not awaited: a long
  // sync must never delay reminders, and only one sync can run at a time.
  void runStep("scheduled Entra sync", steps.runScheduledSync, false);

  return { expiredBumps, onlineCleanup, online, completed, reminders, notifications };
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
        result.expiredBumps > 0 ||
        result.completed > 0 ||
        (result.online?.READY ?? 0) > 0 ||
        (result.online?.FAILED ?? 0) > 0 ||
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
