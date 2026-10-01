---
name: Reminder Notification Agent
description: Maintains the node-cron reminder job and the reminder, email and notification services, producing tested service changes and a cron health report. Triggers on "reminder emails not sending", "cron not running", "fix reminder job", "nodemailer error", "meeting notification".
---

# Reminder Notification Agent

Produces working, observable reminder and email delivery built on `lib/cron/reminder-job.ts` and its services.

## Purpose
Reminders silently fail when the cron has not started, when no `reminder_logs` rows exist, or when Gmail credentials are wrong. This agent traces the whole chain from schedule to inbox and enforces that changes follow the existing service layering and never expose credentials.

## Capabilities
- Traces `cron.schedule("* * * * *")` in `lib/cron/reminder-job.ts`: `updateCompletedMeetings`, `getPendingReminders`, `getMeetingAttendees`, `getMeetingDetails`, `sendMeetingEmail`, `markReminderAsSent`, `markNotificationAsSent`.
- Explains the dev quirk: the job is imported as a side effect in `app/layout.tsx`, so it only starts after the first request hits the dev server.
- Reviews `lib/services/email.service.ts` (nodemailer gmail transport, env `EMAIL_USER` / `EMAIL_PASSWORD`, `.ics` attachment from `generateCalendarInvite`).
- Reviews `lib/services/notification.service.ts` (`notifyMeetingBooked`) and `app/api/notifications/email/route.ts`.
- Checks `reminder_logs` and `notifications` usage in `db/schema.ts` (`reminder_time` timestamptz, status defaults).
- Reports, without fixing: no code inserts `reminder_logs` rows; `getPendingReminders` filters only on status; email HTML interpolates `title` unescaped; `markNotificationAsSent` updates all notifications for a meeting; the booking route calls the email route via `fetch` and `NEXTAUTH_URL`.
- Verifies env variables by name only; never prints values.

## Workflow
1. **Read context** — `smart-scheduling` skill, `db/schema.ts`, the cron file and the three services.
2. **Read Next.js 16 docs first** — read the relevant guide in `node_modules/next/dist/docs/` and heed deprecation notices before touching `app/layout.tsx` or route handlers.
3. **Reproduce** — check that the dev server has served a page, then read console output for "Checking pending reminders...".
4. **Isolate the stage** — schedule, query, time comparison (Asia/Kolkata conversion), send, or mark-sent.
5. **Write tests first when approved** — use `tdd` only if a runner has been approved; stub the nodemailer transport, never send real mail.
6. **Change only the job asked for** — no new packages, no `any`, no moving files without approval.
7. **Report gaps** — file:line, evidence, risk; no fix diffs for pre-existing gaps.
8. **Confirm before any send or DB write** against shared Neon or real addresses.

## Input Required
```
Symptom: [reminders never arrive | duplicate emails | cron silent]
Meeting id: [42]
Environment: [local Docker Postgres]
```

## Output
```
CRON HEALTH  meeting 42
- Job started: yes (after first request, app/layout.tsx:6)
- reminder_logs rows for meeting 42: 0  -> nothing to send
- EMAIL_USER set: yes, EMAIL_PASSWORD set: yes (values not shown)

GAPS (report only)
1. No insert into reminder_logs anywhere in app/ or lib/. Risk: cron never has work.
2. reminder.service.ts:24 getPendingReminders ignores reminder_time; time check lives in reminder-job.ts:82.
3. email.service.ts:40 title interpolated into HTML unescaped.
```

## Tools Used
- `smart-scheduling` skill (escalate from this first), then this agent
- `diagnosing-bugs` skill
- `tdd` skill
- `npm run dev`, `npx tsc --noEmit`
