# Architecture (as implemented)

This describes the application as it is today. Planned or deferred work is listed
at the end and is not part of the running system. Operations, environment
variables and validation status are in `DEPLOYMENT.md`; tests in `tests/README.md`.

## Shape

One Next.js 16 (App Router, React 19) server process with PostgreSQL through
Drizzle ORM. Pages are server components that read through services; client
components are used for forms, tabs, the dashboard and dialogs. There is no
separate API tier or queue: route handlers under `app/api/**` and pages call the
same functions in `lib/services/*.service.ts`, and a node-cron scheduler runs
inside the server process (`instrumentation.ts`, `lib/cron/reminder-job.ts`).

```
browser -> pages (server components) --\
        -> app/api route handlers ------+-> lib/services -> Drizzle -> PostgreSQL
                                        |        |
node-cron (in process) -----------------/        +-> SMTP (Nodemailer), Microsoft Graph
```

## Identity and authorization

- **Sign-in:** Auth.js v5 with Google OAuth only. The e-mail must be verified
  and match an active `Employee` row (case-insensitive); anyone else is refused.
  Sessions expire after 12 hours idle and have an absolute 12-hour cap.
- **Employees:** `Employee.is_active` (deactivated people cannot sign in and
  existing sessions stop working: the user is re-read on every request).
  `Employee` rows come from the Entra directory sync or are created by admins.
- **Groups and permissions:** each employee is in exactly one active group
  (database-enforced). A group carries a priority rank, permissions
  (`booking.*`, `dashboard.view`, `groups.manage`, `rooms.manage`, ...), allowed
  meeting types and bookable rooms. The Admin role keeps room management and
  group administration. A non-admin group manager cannot edit or delete a
  privileged group (one granting a privileged permission) and cannot move
  Admins.
- **Server-side checks everywhere:** pages redirect, but every API route checks
  the session and the permission again (`lib/permissions.ts`,
  `lib/auth-helpers.ts`); only the organizer or an Admin edits, moves or
  cancels a meeting. Mutating requests also pass an origin check
  (`guardMutation`) and per-user in-memory rate limits (`lib/api.ts`).

## Bookings and rooms

- **Booking** (`booking.service.ts`): one transaction takes a per-room advisory
  lock, validates the rules (at least 15 minutes, at least 15 minutes from now,
  first date within 3 months, room active and not archived, capacity, group
  room and meeting-type access), then inserts. Overlap is also enforced by a
  Postgres exclusion constraint (`meeting_no_room_overlap`), so concurrent
  requests cannot double-book.
- **Priority** (`priority.service.ts`): a booking from a higher-ranked group may
  take a slot held by a lower one (the loser becomes *Pending reschedule* and is
  cancelled automatically 30 minutes before start if nothing is done; or is
  *Replaced* when preempted outright). Rank is recorded per booking.
- **Moves** (`reschedule.service.ts`): changing room, date or time of one
  meeting runs the same checks under the same locks and never bumps anyone.
- **Rooms** (`room.service.ts`): create, update, archive (`rooms.archived_at`),
  visibility by group. Taking a room out of service, shrinking its capacity or
  archiving it is refused while meetings need it; the refusal lists them. Only
  `createBooking` and `moveLockedMeeting` assign a room to a meeting, and both
  reject archived rooms.
- **Series** (`recurring-meeting.service.ts`, `series.service.ts`,
  `meeting-series.service.ts`): every occurrence is its own `meeting` row under
  one `recurring_meetings` row. Edit/cancel scopes are single, following, series;
  skipped dates are remembered so a series can be extended or shortened without
  recreating cancelled dates. Lock order is room lock, then the series row, then
  meeting rows.

## Notifications and calendar

- **Outbox** (`notification.service.ts`, `reminder.service.ts`,
  `delivery-admin.service.ts`): a transaction that changes a meeting writes
  `notifications` rows; delivery happens after the commit. A row is claimed
  with a lease (`SENDING`), sent outside any transaction, and recorded, fenced by
  an attempt counter. Failures back off 1, 2, 4, 8 minutes, five attempts, then
  `FAILED`, which an admin can requeue. Permanent SMTP errors (5xx) fail at once.
  Delivery is **at least once**.
- **E-mail** (`email.service.ts`): one configured sender and SMTP relay;
  multiple recipients go in Bcc; times carry a time-zone label. People who declined are left out of
  update e-mails (not of invitations or cancellations).
- **Calendar** (`calendar.service.ts`): ICS with a stable UID
  `meeting-{id}@{host}`, `SEQUENCE` taken from `meeting.ics_sequence`, `REQUEST`
  for new/updated meetings, `CANCEL` (sequence + 1) for cancellations, and
  `PUBLISH` for a series. Meetings are stored as wall-clock date and time in
  `APP_TIMEZONE` (Asia/Kolkata) and exported with explicit offsets.
- **Reminders** run from the in-process scheduler, with the same claim/lease
  and backoff logic.

## Microsoft Teams (optional)

`online-meeting.service.ts` and `teams-meeting.service.ts`. Booking never waits
for Graph: a meeting is stored with `online_status = PENDING`; a scheduler job
creates or updates the event (client-credentials token, throttling and transient
errors retried with backoff, a lease and `online_version` so stale work is
discarded), then sets `READY` and stores the join link, or `FAILED` after the
retry limit. Booking e-mails are held while PENDING (up to
`ONLINE_INVITE_MAX_WAIT_MINUTES`) and the link follows as an update if late.
Rename/move updates the same event; cancel deletes it. Admin endpoints:
`GET /api/admin/teams` (state), `.../health`, `POST .../retry`; the organizer
can retry their own failed meeting.

## Dashboard, reports and audit

`booking-dashboard.service.ts` builds one WHERE clause shared by the KPI cards,
the table and the exports (`lib/dashboard-params.ts` validates it). Reports
(`report.service.ts`) stream CSV/XLSX/PDF in batches, are capped at
`REPORT_MAX_ROWS`, and each export is logged to the append-only
`group_audit_logs`. Group, permission, Entra-setting and export actions are
audited there; meeting changes in `meeting_audit_logs`.

## Data

Drizzle schema in `db/schema.ts`; forward migrations in `drizzle/` (applied
manually at deploy time, never at boot); manual rollbacks in `drizzle/down/`.
Constraints do the heavy lifting: the no-overlap exclusion constraint, one active
group per employee, status check constraints, append-only triggers on audit
tables.

## Not implemented (deferred, not part of the running system)

Microsoft Entra ID sign-in (Google is used), a different e-mail provider, Key
Vault or managed identity, shared rate limiting, a screen for export audit
entries, production monitoring and deployment infrastructure.

The plan for hosting on Azure, signing in with Entra ID and using the
application inside Microsoft Teams, and the changes that must happen before any
production deployment, are in `PRODUCTION_ARCHITECTURE.md`. It is a plan only;
none of it is part of the running system.
