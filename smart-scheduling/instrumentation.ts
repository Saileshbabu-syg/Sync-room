// Runs once when the Next.js server process starts (not during `next build`).
// The reminder scheduler is started here rather than as a side effect of
// importing it from app/layout.tsx, which only started it on the first page
// render after a restart. Set REMINDER_CRON_ENABLED=false to run an instance
// without the scheduler.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Misconfigured mail/auth must be visible at boot, not only when the first
  // booking fails to send or the first user cannot sign in. Bookings keep
  // working; their e-mails stay queued and are retried once the configuration
  // is fixed.
  if (process.env.NODE_ENV === "production") {
    const { emailConfigProblems } = await import(
      "@/lib/services/email.service"
    );

    for (const problem of emailConfigProblems()) {
      console.error(`E-mail configuration: ${problem}`);
    }

    const { authConfigProblems } = await import("@/lib/auth-config");

    for (const problem of authConfigProblems()) {
      console.error(`Auth configuration: ${problem}`);
    }
  }

  const { startReminderScheduler } = await import("@/lib/cron/reminder-job");

  startReminderScheduler();
}
