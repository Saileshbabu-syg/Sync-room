# Deployment guide

The hosting provider is **not decided yet**. This document records what the
application needs from any host and the checks to run before go-live. It does
not name a production hostname, SMTP server or hosting service; those are owner
decisions (see the end).

Every variable is listed with placeholders in `.env.example`.

## 1. Runtime

- **Node.js >= 20.9** (a hard requirement of Next.js 16). Develop, run CI and run
  production on the same major version; Node 22 or 24 LTS is recommended.
- The app is a long-running Node server (`next start`). It is **not** suitable
  for serverless-only hosting (see section 7).
- `bcrypt` is a native module: install and build on the same OS/libc as the
  runtime (glibc vs musl/Alpine).
- Production installs need dev dependencies **at build time**: Tailwind and
  `shadcn/tailwind.css` are consumed by the CSS build only. `shadcn` is a dev
  dependency and is not loaded at runtime (verified: nothing in `.next/server`
  references it). Build, then run with production dependencies only.

## 2. Environment variables

| Variable | Local dev | Tests | Production |
| --- | --- | --- | --- |
| `DATABASE_URL` | local container URL | set by `tests/setup.ts` from `TEST_DATABASE_URL` | managed PostgreSQL URL with `?sslmode=verify-full` |
| `POSTGRES_PASSWORD` | for `docker compose` | n/a | n/a (managed DB) |
| `TEST_DATABASE_URL`, `TEST_ADMIN_DATABASE_URL` | n/a | `.env.test` (local `ss_test_*` DB only) | never |
| `AUTH_SECRET` | random | dummy | **required**, random, >= 32 chars, per environment |
| `AUTH_URL` | `http://localhost:3000` | harness sets it | **required**, public `https://` origin |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client | dummy | **required** |
| `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` | app registration (for **Sync from Entra ID**) | unset | only to use the sync; app registration needs the **User.Read.All** *application* permission with admin consent; **Group.Read.All** and **GroupMember.Read.All** too if you use the Entra group mapping |
| `TEAMS_TENANT_ID` / `TEAMS_CLIENT_ID` / `TEAMS_CLIENT_SECRET` / `TEAMS_ORGANIZER_EMAIL` | dedicated Teams app registration + organizer mailbox | unset (tests use a fake Graph) | only to offer **Online Teams Meeting**; all four or none (see 9a) |
| `REPORT_MAX_ROWS` | optional | tests pass their own | optional; most bookings one dashboard report may contain, a larger selection is refused with 422 (default 5000, see 5a) |
| `ONLINE_INVITE_MAX_WAIT_MINUTES` | optional | tests set it per case | optional; how long online-meeting e-mails wait for the Teams link (default 15, see 9a) |
| `EMAIL_FROM` | set | dummy | **required**, one address |
| `SMTP_HOST` / `SMTP_PORT` | relay or local sink | local sink | **required** |
| `SMTP_USER` / `SMTP_PASSWORD` | if relay needs auth | unset | if relay needs auth |
| `SMTP_SECURE` | optional | n/a | optional (see 4) |
| `SMTP_ALLOW_INSECURE` | dev sink only | harness only | **never** |
| `ENTRA_SYNC_MAX_DEACTIVATIONS` / `ENTRA_SYNC_MAX_DEACTIVATION_PERCENT` | optional | tests pass their own | optional; safety threshold for deactivating people missing from Entra (defaults 25 / 10, see 3) |
| `TRUST_PROXY_HEADERS` | n/a | n/a | only behind a reverse proxy that overwrites `X-Forwarded-Host` and sets `X-Forwarded-For` (see 3) |
| `REMINDER_CRON_ENABLED` | default on | `false` | `false` on all but one instance if you want a single scheduler |
| `REMINDER_LEAD_MINUTES` | default 15 | n/a | integer only |
| `INTERNAL_API_SECRET` | unset | n/a | unset unless `/api/notifications/email` is wanted |

At boot (production only) the server logs one line per configuration problem
for e-mail and Auth.js (`E-mail configuration: ...`, `Auth configuration: ...`).
Messages name variables, never values. Bookings keep working with bad mail
config; their e-mails stay queued and are retried with backoff (about 15
minutes in all); anything still undelivered then is listed as failed and can be
requeued once the configuration is fixed (see section 4).

## 3. Authentication (Auth.js v5 beta, Google OAuth) and origin checks

Verified against the installed version (`next-auth@5.0.0-beta.32`,
`@auth/core@0.41.3`) by `tests/unit/auth-env.test.ts`:

- `AUTH_SECRET` is preferred; `NEXTAUTH_SECRET` is still read as a fallback.
- `AUTH_URL` and `NEXTAUTH_URL` are both used to pin the request origin, so the
  callback URL is always built from the configured origin, never from the
  incoming `Host` header.
- In production `trustHost` is turned on only by `AUTH_URL`, `AUTH_TRUST_HOST`,
  `VERCEL` or `CF_PAGES`. **`NEXTAUTH_URL` alone does not enable it**: sign-in
  fails with `UntrustedHost`. Canonical setting: `AUTH_SECRET` + `AUTH_URL`.
- Do not set `AUTH_TRUST_HOST=true` when `AUTH_URL` is set; it is not needed.

Google OAuth: in the Google Cloud console the OAuth client must list the
authorised redirect URI **`<AUTH_URL>/api/auth/callback/google`** (local:
`http://localhost:3000/api/auth/callback/google`) and the matching JavaScript
origin. The production URI can only be registered once the hostname exists.

State-changing API routes (booking, recurring, edit, cancel, room
create/edit/delete) call `guardMutation` (`lib/api.ts`), which rejects
cross-site requests: `Sec-Fetch-Site` must be same-origin/none, `Origin` (or,
when absent, `Referer`) must be the application, and JSON bodies must be
`application/json`. What "the application" means:

- `AUTH_URL` set (always in production): exactly that origin (scheme + host).
  Forwarded headers are ignored.
- `AUTH_URL` not set (local/test): the request `Host`. `X-Forwarded-Host` is
  used only if `TRUST_PROXY_HEADERS=true`, which you may set only when a
  reverse proxy in front of the app overwrites that header.

The public invitation-answer endpoint (`/api/invitations/respond`) is limited
to 30 requests a minute per client IP. The IP is taken from the right-most
`X-Forwarded-For` entry (the one the proxy appended) only when
`TRUST_PROXY_HEADERS=true`; otherwise all callers share one bucket, so a
client cannot pick a fresh bucket by inventing headers.

Sign-in and sessions:

- Only Google accounts whose e-mail Google reports as **verified** get in, and
  only if the address matches an **active** `Employee` row (compared without
  regard to case). Refusals land on `/login` with a readable message; details
  go to the server log only.
- A session lasts **12 hours**: it ends after 12 hours idle and, at the
  latest, 12 hours after sign-in (`SESSION_MAX_AGE_SECONDS` in
  `lib/auth-config.ts`). Role, group and active status are still re-read from
  the database on every request, so they take effect immediately.

Group Management (non-Admin managers): only the **Admin role** can create
groups, change any group's priority, permissions or meeting types, change
meeting type priorities, or edit, delete or move people into or out of a
group with administrative permissions (`group.manage`, `rooms.manage`,
`dashboard.view`, `booking.outranks`, `booking.protected`). Other managers can
edit ordinary groups' details, rooms and limits, and move non-Admin employees
(not themselves) between ordinary groups that do not rank above their own.

Employee lifecycle: `Employee.is_active` (migration 0036). Deactivated people
cannot sign in, and any session they still hold stops working on the next
request; their rows and bookings are kept. The Entra sync deactivates people
linked to a directory account that is gone or disabled, **only** after a
complete, successful read of the directory, never when the directory comes
back empty, and never more than `ENTRA_SYNC_MAX_DEACTIVATIONS` (default 25)
people or `ENTRA_SYNC_MAX_DEACTIVATION_PERCENT` (default 10) percent of the
linked active employees in one run. Over the threshold, nobody is deactivated
and the run records why (`employee_sync_runs.deactivation_note`). People added
by hand and never matched to the directory are left alone; anyone who returns
to the directory is reactivated.

## 4. E-mail

All booking e-mail (new booking, recurring series, update, cancellation,
reminder) goes through `lib/services/email.service.ts`: one transport, one
sender (`EMAIL_FROM`). Recurring confirmations list every confirmed occurrence
with its date and time. Delivery is queued in the database and retried.

Delivery lifecycle (both queues: `notifications` and `reminder_logs`,
migration 0037):

1. **Claim.** One committed statement moves a due row to `SENDING`, counts the
   attempt and gives the worker a 5-minute lease. `FOR UPDATE SKIP LOCKED`
   plus the status change mean two workers (or instances) never claim the same
   row.
2. **Check and send**, with **no database transaction open**. Before a
   booking confirmation or an update is sent, the meeting must still be
   scheduled and not ended; otherwise the row is `SKIPPED` with the reason in
   `last_error` (cancellations are still sent).
3. **Record** the result: `SENT`; `PENDING` again with exponential backoff
   (1, 2, 4, 8 minutes ... capped at 1 hour); or `FAILED` after
   `MAX_DELIVERY_ATTEMPTS` (5) or at once for a permanent SMTP refusal (5xx, or
   no valid recipient). The reason is stored in `last_error` without e-mail
   addresses. The result is fenced by the attempt number, so a stalled worker's
   late result cannot overwrite a newer attempt's.
4. **Recovery.** A row left `SENDING` by a worker that died is taken over when
   its lease expires; if that was already the last attempt it becomes `FAILED`
   ("delivery outcome unknown") instead.

Delivery is **at least once**, not exactly once: SMTP cannot guarantee
exactly-once, so a crash after the relay accepted a message but before `SENT`
was recorded sends it again on recovery. The reminder audit row is written
after `SENT`, outside the delivery error handling, so an audit failure never
causes a re-send.

Recipients: confirmations go to the organizer; invitations to each
participant; updates and reminders to attendees who have not declined;
cancellations and replacements to every attendee. Deactivated employees are
never mailed. A message to several people is sent once with everyone in
**Bcc**, so nobody sees the other attendees' addresses. Dates and times in
every e-mail are labelled with the zone and its UTC offset (e.g.
`Asia/Kolkata (UTC+05:30)`).

Calendar invites (`lib/services/calendar.service.ts`, migration 0038):

- Every meeting has one stable calendar UID, `meeting-<id>@<AUTH_URL host>`,
  used by every invite, update, reminder and cancellation for it. **Keep
  `AUTH_URL` stable**: changing its host changes the UIDs, and calendars would
  treat later messages as new entries.
- `meeting.ics_sequence` is the entry's version. It rises, inside the same
  transaction, when the title changes (edit) or the date, time or room changes
  (reschedule); re-sending without a change keeps it.
- Confirmations, invitations, updates and reminders carry `METHOD:REQUEST`
  with the current version, room as location, and the Teams link (when there
  is one) in the description and URL. Times are written in UTC.
- Cancellations, replacements (preempted) and bumps that were not resolved in
  time carry `METHOD:CANCEL` for the same UID at version + 1, which removes
  the entry. A bumped meeting still waiting for its organizer carries nothing.
- A series confirmation is one `METHOD:PUBLISH` file with an entry per
  occurrence, each under its own UID (iTIP allows one UID per REQUEST).
- Invites name `EMAIL_FROM` as the organizer and do not list attendees (that
  would show everyone's address to everyone). Verify updates and
  cancellations in the calendar clients you use (Outlook, Google, Apple)
  before relying on them.

Meeting lifecycle (migration 0039):

- **Booking rules** (server-enforced): at least 15 minutes long; starting at
  least 15 minutes from now (application time zone, checked under the locks
  right before the write) for bookings, series, moves and series time changes;
  the first date within 3 months (later occurrences of a series may run
  further, B-05). Only the organizer or an Admin may edit, move or cancel; there
  is no separate edit permission (B-10).
- **Move** (`PATCH /api/meetings/reschedule/:id`): a scheduled meeting, or one
  waiting to be rescheduled after a bump, moves to another room, date or time
  under the same checks as a new booking, never bumping anyone. Same meeting,
  attendees and answers, calendar UID and Teams event; the calendar version
  rises and attendees get an update after the commit.
- **Series edit / cancel**: `PATCH /api/meetings/edit/:id` with `scope` and
  `PATCH /api/meetings/cancel/:id?scope=` accept `single` (default),
  `following` (this and later occurrences) or `series`. Only occurrences that
  still happen are changed; completed, cancelled, replaced and past ones are
  kept for history and reports. A series edit may set a new room and/or time of
  day (each occurrence keeps its date); it is all-or-nothing. Each changed
  occurrence gets its own update or cancellation (its own calendar UID).
  Concurrent operations on one series are serialised by a lock on the series.
- **Series pattern** (`GET`/`PATCH /api/meetings/series/:id`): WEEKLY series
  may repeat every 1-12 weeks; a series may end by a date (inclusive) and/or a
  count, at most 12 occurrences. Changing the end date cancels upcoming
  occurrences after it, or books the pattern's later dates (copying the latest
  upcoming occurrence and the answers already given). Dates skipped at booking
  are stored (`recurring_meeting_skipped_dates`) and never booked again, even if
  they fall after a later end date. The pattern itself (frequency, interval,
  start) cannot be changed: end the series and book a new one.

Failed e-mails: `GET /api/admin/notifications` (Admin role) lists notifications
and reminders parked as `FAILED`, newest first, with the reason;
`POST /api/admin/notifications/retry` with `{ "kind": "notification" |
"reminder", "id": n }` puts one back in the queue with fresh attempts (audited
as `EMAIL_REQUEUED`). The usual checks run again, so a message that no longer
applies is skipped rather than sent. Check this list after a relay outage or a
configuration fix.

- Port 587 uses STARTTLS and it is **mandatory**: if the server does not offer
  it the send fails instead of continuing in plaintext. Port 465 uses implicit
  TLS. TLS >= 1.2; certificates are verified. Connection/greeting/socket
  timeouts are bounded.
- `SMTP_ALLOW_INSECURE=true` exists only for a local sink and is refused for a
  non-local host when `NODE_ENV=production`.
- Older `.env` files used `EMAIL_USER` / `EMAIL_PASSWORD`; these are **not**
  read. Rename them to `SMTP_USER` / `SMTP_PASSWORD` and add `SMTP_HOST` and
  `EMAIL_FROM`. The boot check reports leftover legacy names.

## 5. Database

- Use TLS to managed PostgreSQL: append `?sslmode=verify-full` to
  `DATABASE_URL` (add `sslrootcert=` for a private CA). `pg` treats `require` as
  `verify-full` anyway and prints a warning.
- **Migrations:** run `npx drizzle-kit migrate` as an explicit deploy step with a
  migration-capable credential, before starting the new version. Do not migrate
  at application boot (several instances would race). Take a backup/snapshot
  first; migrations are forward-only.
- **Backups:** enable the provider's automated backups and point-in-time
  restore; test a restore before go-live.
- `docker-compose.yml` is for local development only: it requires
  `POSTGRES_PASSWORD` and publishes the port on `127.0.0.1` only.

### Migration order and rollback

Migrations are applied in journal order (`drizzle/meta/_journal.json`, 42
entries, `0000` to `0041`); applied ones are never edited. The ones that
changed behaviour in the stabilization phases:

| Migration | Adds |
| --- | --- |
| `0036_employee_lifecycle` | `Employee.is_active`, `deactivated_at`, case-insensitive e-mail indexes |
| `0037_delivery_leases` | outbox lease/backoff columns (`next_attempt_at`, `locked_until`, `last_error`), `SENDING` status |
| `0038_calendar_sequence` | `meeting.ics_sequence` |
| `0039_series_lifecycle` | series interval/until date/pattern start, `recurring_meeting_skipped_dates` |
| `0040_online_provisioning` | Teams state, fencing version, retry and lease columns on `meeting` |
| `0041_room_archive` | `rooms.archived_at` (nullable; every existing room stays active) |

`drizzle/down/*.down.sql` holds a manual rollback for 0027 to 0041 (the
migrator ignores that folder). Run them newest first against the database, then
delete the matching rows from `drizzle.__drizzle_migrations` before migrating
forward again. The test suite runs the 0041 to 0036 rollbacks and the forward
re-apply on a throw-away database (`tests/db/migrations.test.ts`); rooms,
meetings and employees survive. Rollback limits: archived rooms become active
again (the archive flag is lost), and the delivery-lease down script puts
`SENDING` outbox rows back to `PENDING` (they may be sent again, which the
at-least-once design allows). Never roll back on a shared database without a
snapshot. Deploy the matching application code with the migration: code newer
than the schema fails on the missing columns.

## 5a. Rooms, dashboard, reports and background work

- **Rooms:** people with room management (`rooms.manage` or the Admin role)
  see every room; everyone else sees only active rooms their group may book.
  A room can be archived (`PATCH /api/rooms/:id/archive`): it is refused while
  meetings are booked in it (the response lists them), archived rooms cannot be
  booked, moved into or suggested, and past meetings keep their room.
  Taking a room out of service (maintenance) and cutting its capacity below an
  upcoming meeting are refused the same way; nothing is ever cancelled
  automatically. Both room PATCH routes use one service (`room.service.ts`).
- **Dashboard** (`dashboard.view`): the page, `GET /api/dashboard/bookings`
  and the report all use the same filters. `page`, `pageSize` (1 to 100),
  `sort` and the search text (100 characters) are validated; bad values are
  400, never silently replaced.
- **Reports** (`GET /api/dashboard/report?format=csv|xlsx|pdf`): at most
  `REPORT_MAX_ROWS` bookings (default 5000), larger selections get 422 with a
  message to narrow them. Every export writes a `REPORT_EXPORTED` row to
  `group_audit_logs` (who, format, period, filters, row count). That table is
  append-only (database trigger). There is no screen to read these entries yet;
  query the table. A cancelled download stops reading from the database.
- **Background work** (one scheduler instance, `REMINDER_CRON_ENABLED`):
  reminders, the outbox (leases, backoff 1/2/4/8 minutes, 5 attempts, then
  FAILED and requeueable), Teams provisioning (retries with backoff, FAILED
  after the limit, admin retry), the bump-cutoff cancellation and the Entra
  sync. E-mail delivery is **at least once**: a crash between sending and
  recording can send a message twice.
- **Health and recovery:** `GET /api/admin/teams/health` (Teams), the failed
  e-mail list and requeue (section 4), and `POST /api/admin/teams/retry` (admin) and `POST /api/meetings/online/:id` (the organizer).

## 6. Secrets

- Never commit `.env*` (only `.env.example`, which holds placeholders).
- Store production values in the platform's secret store: Azure Key Vault
  (referenced from App Service / Container Apps settings), or Azure DevOps
  variable groups (secret, optionally linked to Key Vault) for pipeline use.
- CI needs one secret, `CI_POSTGRES_PASSWORD`, for its throw-away test database.

### Credential rotation: the old local PostgreSQL password

The password that used to be hard-coded in `docker-compose.yml` is in Git
history (commit `d37b0bc`, present on the GitHub remote and its branches). The
old compose file also published port 5432 on all interfaces, so anyone on the
same network who knew it could connect to a developer's local database. Where it
is used (checked, values not shown): your untracked `.env.test` (local test
database). It is **not** in `.env`, whose database is a different, managed one.
That does not prove the same string was never set on another database; ask the
team.

1. Generate a new value: `openssl rand -hex 24`.
2. Local container (`smart-scheduling-db`), keeping its data: run
   `docker exec -it smart-scheduling-db psql -U postgres` and use
   `\password postgres` (avoids the value landing in shell history). **Or**, if
   the data is disposable and you have confirmed the target is the local
   `smart_db_data` volume: `docker compose down -v` then `docker compose up -d`.
3. Put the new value in `.env` (`POSTGRES_PASSWORD`, and `DATABASE_URL` if it
   points at the local container) and in `.env.test` (both `TEST_*` URLs).
4. Ask every developer who ran the old compose file to repeat steps 1-3.
5. Check any other database, CI variable or shared account where the old string
   may have been reused and change it there. Do not change a shared database
   without its owner's approval.
6. Never paste the value into chat, tickets or commits.

**Is a Git history rewrite necessary?** Not for security once the password is
rotated and not reused: the leaked value then protects nothing. Rewriting means
`git filter-repo` plus force-pushing every branch, invalidating all clones, and
GitHub forks/PR refs may keep the old objects anyway. If the organisation wants
a clean history, the migration to Azure Repos is the natural moment (import a
cleaned copy). Needs an explicit owner decision; nothing has been rewritten.

## 6a. Remaining dependency advisories

`npm audit --omit=dev` (what ships to production): **0 vulnerabilities**.
`npm audit` (including dev tooling): 7, all dev-only, none installed in
production:

| Package | Severity | Path | Why unresolved |
| --- | --- | --- | --- |
| esbuild 0.18.x | moderate | drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils | advisory is about esbuild's dev server; drizzle-kit does not run it. drizzle-kit 0.31.11 (latest stable) still depends on it; only a 1.0.0 pre-release drops it |
| @esbuild-kit/core-utils, @esbuild-kit/esm-loader, drizzle-kit | moderate | same chain | same |
| deepmerge 4.3.1 | low | shadcn, @shadcn/registry | no patched version exists; the CLI is not shipped |
| @shadcn/registry, shadcn | low | dev dependency | inherits deepmerge; npm's "fix" is a downgrade to shadcn 1.0.0, rejected |

Re-check with `npm audit` whenever drizzle-kit or shadcn publish a release.

## 7. Reminder job (hosting requirement)

`instrumentation.ts` starts a per-minute `node-cron` timer when the server
process boots (Node runtime only; not during `next build`). Properties:

- One scheduler per process (guarded); a tick still running when the next
  minute arrives is skipped; a failing tick (e.g. database down) is logged by
  message only and the schedule continues.
- Each step of a tick (expired bumps, Teams event cleanup, completed meetings,
  reminders, notification retries, scheduled Entra sync) runs on its own: a
  step that fails is logged as `Cron step "<name>" failed: <message>` and the
  following steps still run.
- Several instances are safe: rows are claimed under a lease (see section 4)
  and there is a unique reminder per meeting. Delivery is **at-least-once**:
  if a process dies after the mail relay accepts a message but before `SENT` is
  recorded, that message is sent again when its lease expires.
- Due times are computed in SQL from the meeting's wall-clock date and time in
  `APP_TIMEZONE` (`Asia/Kolkata`), minus `REMINDER_LEAD_MINUTES`.
- It needs a host with a **continuously running process**: App Service (Always
  On, Basic tier or higher), a VM, or a container app with a minimum of one
  replica. Scale-to-zero, serverless functions and idle recycling stop
  reminders. If the chosen host cannot guarantee that, run
  `runReminderTick()` (`lib/cron/reminder-job.ts`) from an external scheduler or
  a dedicated worker and set `REMINDER_CRON_ENABLED=false` on the web instances.

## 8. Build and deploy steps (host-neutral)

1. `npm ci` (Node >= 20.9).
2. `npm run typecheck && npm run lint && npm run test:unit`.
3. `npm audit --omit=dev --audit-level=high`.
4. `npm run build`.
5. Back up the database, then `npx drizzle-kit migrate`.
6. Start with `npm start` (or the container equivalent) with the section 2
   variables from the secret store. Check the boot log for
   `E-mail configuration:` / `Auth configuration:` lines.
7. Smoke test: Google sign-in, one booking, one recurring booking, confirm one
   e-mail arrives from `EMAIL_FROM`, confirm a reminder fires.

Packaging is undecided: a code deploy to a Node host needs nothing extra;
a container host would justify a Dockerfile based on `output: "standalone"`.
None is included until the host is chosen.

## 9. CI (Azure Pipelines)

`azure-pipelines.yml` is ready but has **not** been run or connected to any
organisation (it was validated locally: YAML parse and the same commands run
against a local Postgres). It uses Node 22, `npm ci`, and a throw-away
`postgres:16-alpine` service container whose database is `ss_test_main` (the
test safety guard accepts only a local `ss_test_*` database). Steps, all of
which fail the build: typecheck, lint, Drizzle migration consistency
(`drizzle-kit check`), unit tests, production dependency audit (high or above),
database tests, a production-mode build (`build:test`, a `next build` with the
isolated test environment) and end-to-end tests. The unit step needs the same
`TEST_*` variables as the others because `tests/setup.ts` refuses to start
without them. Add the secret variable
`CI_POSTGRES_PASSWORD` in Azure DevOps first. The file lives in `smart-scheduling/`;
point the pipeline at that path (or move it to the repository root).

## 9a. Online Teams meetings (Microsoft Graph)

The booking form's **Online Teams Meeting** checkbox creates a real Teams
meeting. It is shown only when the four `TEAMS_*` variables are set.

How it works (background provisioning, migration 0040):

- **A booking never waits for Microsoft.** With the checkbox ticked, every
  occurrence is saved with `online_status = PENDING` and the confirmation and
  invitation e-mails are queued in the same transaction. Requests (booking,
  move, rename, cancel) make no Graph call.
- **The worker** (a step of the per-minute job, also nudged right after a
  commit) claims due PENDING meetings one at a time (`FOR UPDATE SKIP LOCKED`,
  a 2-minute lease in `online_locked_until`, attempt counted), creates or
  updates the event with no database transaction open, and records the result
  fenced by the attempt number:
  - no event yet: `POST /users/{TEAMS_ORGANIZER_EMAIL}/events` with
    `isOnlineMeeting: true`, `onlineMeetingProvider: teamsForBusiness`, the room
    as location, no attendees, and `transactionId = sched-meeting-<id>` (a
    repeated create returns the same event); the event id and `joinUrl` are
    stored and the meeting becomes **READY**;
  - event exists (after a move or a rename): `PATCH` of subject, start, end and
    location on the same event (same link);
  - the event was deleted in Outlook (404 on PATCH): a new one is created.
- **State machine**: `NONE` (no Teams) → `PENDING` → `READY`; a move or
  rename sets `PENDING` again with `online_version + 1`; a worker only marks
  READY if the version is still the one it worked on (stale work never
  overwrites a newer change). Retryable failures stay `PENDING` with
  `online_next_attempt_at`; after 5 attempts, or at once for a permanent error,
  **FAILED** (reason in `online_last_error`). A worker that died is replaced
  when its lease expires (or FAILED if it was the last attempt).
- **Retries**: HTTP 429, 408, 500, 502, 503, 504, timeouts, network errors and a
  temporarily unavailable sign-in are retried; Microsoft's `Retry-After` is
  respected, otherwise 30 s, 1, 2, 4 min ... (max 30 min) with ±20% jitter.
  Permission (403), bad request, missing configuration and a refused
  credential fail at once. Errors are stored and logged without response
  bodies, tokens or secrets.
- **E-mails**: the confirmation, invitations and updates of an online meeting
  wait while it is PENDING (re-checked every 30 s without using up a delivery
  attempt), so they carry the link and calendar entry. They wait at most
  `ONLINE_INVITE_MAX_WAIT_MINUTES` (default 15) and not at all once Teams
  FAILED: then they go out without a link (the booking stands). If the link
  arrives after they went out, everyone gets a "Meeting Updated" e-mail with a
  new version of the calendar entry carrying it. Reminders and cancellations
  never wait.
- **Cancellation**: cancelled, replaced and expired meetings are never
  provisioned; a sweep in the same job deletes their events (an already deleted
  event counts as deleted), retrying failures with backoff.
- **Series**: one event per occurrence; edits and cancellations touch only the
  affected occurrences; extending a series provisions only the new ones.
- **Retry**: the organizer or an Admin can retry a FAILED meeting from its
  booking page ("Retry Teams meeting"); Admins also have
  `GET /api/admin/teams` (counts and records per status, default FAILED, with
  the reason, attempts and next retry), `POST /api/admin/teams/retry`
  `{ meetingId }`, and `GET /api/admin/teams/health`.
- **Health check** (`GET /api/admin/teams/health`, Admin role): checks
  configuration, sign-in (an app-only token is issued), the granted
  `Calendars.ReadWrite` application permission (from the token's roles) and
  access to the organizer mailbox's calendar. It creates nothing and never
  returns tokens or secrets. It cannot read the client secret's expiry date:
  **track the expiry in the Entra portal and rotate before it lapses** (a lapsed
  secret shows as a failed sign-in and new meetings go FAILED).
- Existing rows at migration time: a stored event is READY; Teams requested but
  never created on a meeting that still happens is FAILED (retry it); the rest
  NONE.

All Graph code is in `lib/services/teams-meeting.service.ts`, the worker in
`lib/services/online-meeting.service.ts`; users still sign in with Google.

### Microsoft configuration (tenant administrator)

1. **Organizer mailbox**: a licensed user or shared mailbox with Exchange Online
   and Teams, whose Teams policy allows scheduling meetings. Its address is
   `TEAMS_ORGANIZER_EMAIL`. Events appear in this mailbox's calendar.
2. **Entra app registration** (single tenant, new, separate from the directory
   sync one): create a client secret (note its expiry date; a lapsed secret
   shows as "Microsoft rejected the Teams credentials"). Copy tenant id,
   client id and secret into `TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`,
   `TEAMS_CLIENT_SECRET`.
3. **Graph permission**: *Application* permission `Calendars.ReadWrite`
   (nothing else is needed: no OnlineMeetings.*, no Mail.*, no User.*).
4. **Restrict it to the organizer mailbox** in Exchange Online, otherwise the
   permission reaches every mailbox in the tenant. Either:
   - *RBAC for Applications* (current Microsoft guidance): register the app as
     an Exchange service principal, create a management scope that matches only
     the organizer mailbox, and assign the `Application Calendars.ReadWrite`
     role to the app with that scope (`New-ServicePrincipal`,
     `New-ManagementScope -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<mailbox>'"`,
     `New-ManagementRoleAssignment -App ... -Role "Application Calendars.ReadWrite" -CustomResourceScope ...`).
     With this model do **not** also grant tenant-wide admin consent for
     `Calendars.ReadWrite` in Entra: the two add up and the broad consent wins.
   - or, *Application Access Policy* (older): grant the Entra admin consent from
     step 3 and add `New-ApplicationAccessPolicy -AccessRight RestrictAccess`
     for a mail-enabled security group containing only the organizer mailbox.
   Check with `Test-ServicePrincipalAuthorization` (RBAC) or
   `Test-ApplicationAccessPolicy` (policy). Both can take up to an hour to take
   effect. These steps were written from Microsoft's documentation and were
   **not** executed against a tenant by the developer; follow the current
   Microsoft Learn pages when applying them.
5. Set the four variables (secret store in production) and restart.

### Limits to know about

- Everyone joins through the organizer mailbox's meetings; the application user
  who booked is the organizer in the application, not in Teams (no lobby bypass
  or co-organizer is configured).
- Attendees are not added to the Outlook event, so the Teams meeting does not
  appear in their calendars by itself; the application e-mail and its .ics
  attachment (which contains the link) do that.
- Graph de-duplicates a repeated create (`transactionId`) only for a limited
  time; a worker that died after Microsoft created the event and whose retry
  comes much later could create a second event. The unique index on
  `online_event_id` keeps it from being attached to two meetings; the orphan
  would remain in the organizer calendar.
- E-mails of an online meeting can arrive up to `ONLINE_INVITE_MAX_WAIT_MINUTES`
  later than for a normal meeting when Microsoft is slow or down.

### Manual validation in a real tenant (not yet performed)

Run these against the configured tenant before relying on the feature, with the
worker running (a server process with `REMINDER_CRON_ENABLED` not `false`):

1. `GET /api/admin/teams/health`: all four parts `ok: true`.
2. Book one online meeting; within a minute it is READY, the e-mails arrive
   with the link, and the event is in the organizer mailbox (organizer = the
   mailbox).
3. Open the join link (internal account and an external/guest account); note
   the lobby and presenter behaviour.
4. Rename it, then move it to another time and another room: the same event
   changes (same link), attendees get updates.
5. Cancel it: the event disappears from the organizer calendar.
6. Book a weekly series of 3 online; each occurrence gets its own event;
   extend it by 2; only 2 new events appear.
7. Cancel one occurrence, then the rest of the series: their events disappear.
8. Throttling / outage: temporarily point `TEAMS_CLIENT_SECRET` at a wrong value
   (sign-in refused → FAILED, booking stands, e-mails go out without a link),
   restore it and use Retry (link arrives as an update). Simulating a 429 / 503
   needs a proxy in front of Graph or Microsoft's Graph chaos settings.
9. Check the attendee invitation timing and that the .ics updates or removes the
   entry in Outlook, Google Calendar and Apple Calendar.

## 10. Known limitations and owner decisions

- Hosting provider, hostname, SMTP relay, secret store and packaging are
  undecided; production Google redirect URI and `AUTH_URL` depend on the hostname.
- Auth.js v5 is still a beta release (the patched line available today).
- The database and end-to-end suites run locally against a Docker Postgres
  (`smart-scheduling-db`); they have not yet run in Azure Pipelines.
- Git history still contains the old local password (see section 6).
- `REMINDER_LEAD_MINUTES` is parsed with `Number()`; a non-numeric value breaks
  reminder creation. Keep it an integer.
- Rate limiting covers only the authenticated booking/edit/cancel/suggestion
  APIs and is in process memory (per instance, not shared). Sign-in endpoints
  are not rate limited by the app; use the reverse proxy / WAF if needed.

## 11. Validation status and known limitations (stabilization phase)

Validated locally (isolated `ss_test_*` database, no shared database): unit,
database and end-to-end suites, typecheck, lint, `drizzle-kit check`, forward
migration of a clean database, 0041 on a populated database, the 0041 to 0036
rollbacks, a production-mode `next build` from a copy without any `.env` file.

Not validated, owner action needed:

- **Real Microsoft 365 tenant.** The Graph client is tested only against a fake
  Graph. The procedure in 9a (health check, creation, join as internal and
  guest, lobby/presenter, rename/move/cancel, series extension, wrong secret,
  Retry, calendar clients) has not been performed. Needs the four `TEAMS_*`
  settings of a dedicated app registration with admin consent, a licensed
  organizer mailbox and test attendee accounts.
- **Calendar clients** (Outlook, Google Calendar, Apple Calendar): ICS output is
  checked structurally in tests (stable UID, sequence, METHOD, time zone) but
  not opened in a real client.
- **Azure Pipelines:** never run there. Needs the `CI_POSTGRES_PASSWORD`
  secret variable and a pipeline pointing at `smart-scheduling/azure-pipelines.yml`.
- **Browser, mobile and accessibility:** server-rendered end-to-end tests only;
  no manual or automated browser session was possible in the tooling used.
  Needs a person to walk the checklist (login, dashboard, bookings, rooms and
  archive, reports, mobile menu at phone width, keyboard-only use).
- **Terraform credential:** an old `infra/docker/terraform.tfvars` (database
  password) exists in Git history. The file is now ignored and the example holds
  a placeholder, but nothing records that the password was rotated or where it
  was used. The owner must find where that value is (or was) in use, rotate it
  there and ask whether the history should be cleaned (nothing was rewritten).
- **Export audit entries** have no viewing screen: not required by the current
  scope; read `group_audit_logs` (`action = 'REPORT_EXPORTED'`).
- E-mail is at-least-once, not exactly-once (see 5a). Rate limiting is per
  process. Auth.js v5 is a beta release.
