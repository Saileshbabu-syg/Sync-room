import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  resetReminderSchedulerForTests,
  startReminderScheduler,
} from "@/lib/cron/reminder-job";

const IDLE = {
  completed: 0,
  reminders: { sent: 0, skipped: 0, failed: 0, retried: 0 },
  notifications: { SENT: 0, FAILED: 0, PENDING: 0 },
} as unknown as Awaited<
  ReturnType<typeof import("@/lib/cron/reminder-job").runReminderTick>
>;

function harness(tick: () => Promise<typeof IDLE>) {
  const tasks: Array<() => Promise<void>> = [];
  const schedule = (expression: string, task: () => Promise<void>) => {
    assert.equal(expression, "* * * * *");
    tasks.push(task);
  };

  return { tasks, schedule, tick };
}

describe("startReminderScheduler", () => {
  beforeEach(() => resetReminderSchedulerForTests());
  afterEach(() => {
    resetReminderSchedulerForTests();
    mock.restoreAll();
  });

  it("starts once and schedules a per-minute task", () => {
    const h = harness(async () => IDLE);

    assert.equal(startReminderScheduler({ ...h, env: {} }), true);
    assert.equal(h.tasks.length, 1);
  });

  it("does not start a second scheduler in the same process", () => {
    const h = harness(async () => IDLE);

    assert.equal(startReminderScheduler({ ...h, env: {} }), true);
    assert.equal(startReminderScheduler({ ...h, env: {} }), false);
    assert.equal(h.tasks.length, 1);
  });

  it("does not start when REMINDER_CRON_ENABLED=false", () => {
    const h = harness(async () => IDLE);

    assert.equal(
      startReminderScheduler({
        ...h,
        env: { REMINDER_CRON_ENABLED: "false" },
      }),
      false
    );
    assert.equal(h.tasks.length, 0);
  });

  it("logs a failing tick without throwing, and keeps ticking", async () => {
    const error = mock.method(console, "error", () => {});
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("connect ECONNREFUSED postgres://user:secret@db/x");
      }
      return IDLE;
    });

    startReminderScheduler({ ...h, env: {} });

    await h.tasks[0]();
    await h.tasks[0]();

    assert.equal(calls, 2);
    assert.equal(error.mock.callCount(), 1);
  });

  it("skips a tick while the previous one is still running", async () => {
    let calls = 0;
    let release!: () => void;
    const h = harness(() => {
      calls++;
      return new Promise<typeof IDLE>((resolve) => {
        release = () => resolve(IDLE);
      });
    });

    startReminderScheduler({ ...h, env: {} });

    const first = h.tasks[0]();
    await h.tasks[0]();
    assert.equal(calls, 1);

    release();
    await first;
    const third = h.tasks[0]();
    assert.equal(calls, 2);
    release();
    await third;
  });
});
