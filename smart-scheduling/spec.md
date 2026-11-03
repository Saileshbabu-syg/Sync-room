# smart-scheduling

An internal meeting-room booking app: employees book rooms for meetings, admins manage the room inventory. Built with Next.js 16 (App Router), Drizzle ORM + Postgres (Neon), NextAuth v5 (Google OAuth), node-cron for email reminders, Tailwind/shadcn UI.

**Status: local development only** — not deployed anywhere yet. Everyone runs their own `npm run dev` against the shared Neon database.

## Project structure

- `app/` — pages and API routes (App Router). Key folders: `booking/`, `bookings/` (edit/cancel), `dashboard/`, `rooms/`, `login/`, `signup/`, `api/` (all backend routes).
- `db/schema.ts` — all Drizzle table definitions, relations and types in one file.
- `lib/services/` — business logic (conflict checking, room suggestions, dashboard stats, audit logging, notifications, reminders).
- `lib/validations/` — Zod schemas for request validation.
- `lib/cron/` — the reminder email cron job.
- `auth.ts` — NextAuth config and the Employee-table authorization gate.

## Getting access (do this first)

There's no self-signup and no public credentials — get these from whoever set up the project before you can run it:
- The shared Neon `DATABASE_URL` (direct endpoint, see below)
- Google OAuth `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_SECRET` (any shared secret string, ask the team)
- An SMTP relay and sender address (`SMTP_HOST`, `EMAIL_FROM`; see "Email" below) for booking e-mail

**Becoming a test user**: since login requires a pre-existing `Employee` row (there's no self-signup and no employee-management UI yet), ask an admin to insert your row directly — either via the Neon SQL console/dashboard or `psql`:
```sql
INSERT INTO "Employee" (role_id, employee_name, email)
VALUES (<role_id>, 'Your Name', 'your.email@gmail.com');
```
Use the `role_id` for `employee` or `admin` from the `roles` table. Only then can you sign in with that Google account.

## Git workflow

No formal branching/PR convention yet — the team currently pushes/PRs to `main` directly.

## Database

- Shared team database is hosted on **Neon** (not local Docker). `DATABASE_URL` in `.env` must point to the **direct** endpoint, not the `-pooler` one.
  - Neon's pooler uses PgBouncer-style transaction pooling, which breaks Drizzle/`pg`'s prepared statements (`relation "X" does not exist` errors on INSERT, even though the table exists and SELECTs work fine).
  - Correct: `...@ep-xxxx.c-6.us-east-2.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require`
  - Wrong (breaks writes): `...@ep-xxxx-pooler.c-6.us-east-2.aws.neon.tech/...`
- A `docker-compose.yml` exists for spinning up a **local** Postgres container as a fallback/offline option (`docker compose up -d`), matching the schema via `npx drizzle-kit migrate`. Not used for day-to-day team work — Neon is the shared source of truth.
- Schema lives in `db/schema.ts`. Apply changes with `npx drizzle-kit generate` (creates a migration file in `drizzle/`, review it) followed by `npx drizzle-kit migrate`. Do not use `drizzle-kit push`.

## Roles

Only two roles exist: `admin` and `employee`.
- **Admin**: manages rooms (create/edit/delete), can also book rooms.
- **Employee**: can only book rooms.

Meeting types are simplified to in-person only concepts: e.g. `Team Meeting`, `Interview` (no virtual meeting type needed).

## Auth model

- `auth.ts`: Google OAuth via NextAuth. Sign-in is gated — the user's email must already exist in the `Employee` table (joined to `roles`), or login is rejected with `/login?error=not-authorized`. There is **no self-signup** — new employees must be added to the `Employee` table directly (no admin UI for this exists yet).
- On first successful sign-in, an `Organizer` row is auto-created from the `Employee`/`roles` data.

## Security & integrity model (current)

- **Every API route authenticates on the server** (`getCurrentOrganizer()`); there is no public API. `/api/notifications/email` is internal-only and disabled unless `INTERNAL_API_SECRET` is set (the app no longer calls it).
- **Authorization is re-evaluated per request from the `Employee` record** (role + email), not from the JWT or the cached `Organizer.role`. A demoted/offboarded user loses access on the next request.
- **Meetings are private to their organizer, attendees and Admins** (detail page, edit page = organizer/Admin only, room schedule shows "Busy" for other people's meetings).
- **Meeting type access** (`lib/services/meeting-type-access.service.ts`, used by booking, recurring, edit and `/api/meeting-types`): someone in an ACTIVE group may book the types ticked for that group (`group_meeting_types`, edited under Group Management); someone with no usable group falls back to their role's list (`role_meeting_types`, load it with `npx tsx db/seed-priority.ts`). An empty list means the person can book nothing.
- **Double-booking is prevented in the database**: `meeting_no_room_overlap` (EXCLUDE USING gist, half-open ranges, cancelled meetings excluded) plus a single booking transaction with a per-room advisory lock (`lib/services/booking.service.ts`). Back-to-back meetings are allowed; overnight meetings are not supported. Apply schema changes with `drizzle-kit migrate` — never `push` (it does not know about the constraint).
- **Reminders / audit / notifications** are written by the booking transaction itself and processed by the per-minute cron (`lib/cron/reminder-job.ts`) with row claiming (`FOR UPDATE SKIP LOCKED`), so running several instances does not duplicate mail. `REMINDER_LEAD_MINUTES` (default 15) sets the lead time; `REMINDER_CRON_ENABLED=false` turns the scheduler off on an instance.
- Rate limits are per user, per process (`RATE_LIMIT_<BUCKET>_PER_MINUTE` to tune).

## Known issues / gaps (read before assuming something works)

- **Fresh database setup**: migrations now build an empty database, but the lookup rows must be seeded: `npx tsx db/seed-lookups.ts` then `npx tsx db/seed-priority.ts`, and `Employee` rows inserted by hand.
- **Dependencies are behind security fixes** (`next`, `next-auth`, `nodemailer`, `zod`, shadcn tree) — see REMEDIATION_REPORT.md for the upgrade plan; nothing has been upgraded yet.
- **Leftover `Organizer.password` column** from the removed credentials path.
- **Recurring series** have no series-level edit/cancel, and only the first date is checked against the 3-month window (product decisions pending).
- **No employee management UI** — since login requires a pre-existing `Employee` row, there's currently no way to onboard a new teammate except inserting directly into the DB.
- **No CI** is configured; run `npm run typecheck && npm run lint && npm test && npm run build:test && npm run test:e2e` locally (see tests/README.md).
- **`lib/cron/reminder-job.ts`** is imported as a side-effect in `app/layout.tsx`. In dev, Next.js lazily compiles routes, so the cron doesn't start ticking until the first page request hits the server.

## Running locally

```bash
npm install
npm run dev
```
`.env` needs `DATABASE_URL` (Neon direct endpoint), `GOOGLE_CLIENT_ID`/`SECRET`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `EMAIL_FROM` and `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` if the relay needs them) for booking e-mail.

## Email

All booking e-mail (confirmation, recurring-series confirmation, update, reminder) is sent by
`lib/services/email.service.ts` from one sender, configured only through the environment:

| Variable | Purpose |
|---|---|
| `EMAIL_FROM` | Official sender, e.g. `Meeting Rooms <rooms@company.com>`. Required: nothing is sent without it. |
| `SMTP_HOST` | The organisation's approved SMTP relay. Required. |
| `SMTP_PORT` | Default `587`. |
| `SMTP_SECURE` | `true` for implicit TLS (port 465); otherwise STARTTLS is used when offered. |
| `SMTP_USER` / `SMTP_PASSWORD` | Only if the relay requires authentication. |

A recurring booking sends one confirmation listing every saved occurrence (loaded from the
database), plus any skipped or cancelled dates; one-time bookings keep the single-date format.

## Groups, booking priority and the booking dashboard

- **Groups are application data** (`groups`, `user_groups`, `group_permissions`, migration 0027), never Entra/Azure/Google groups. Admin is also a group (migration 0029 adds it where missing), while the Admin *role* (`ROLE_ADMIN`) still guards the admin screens. Defaults: Leadership 1, HR 2, Manager 3, TL 4, Employee 5, Admin 5; migration 0027 maps existing Manager / Team Lead / HR / Employee roles onto them. Priority is a number edited per group (no drag-and-drop, no "P1" labels in the screens). The member count on the Groups tab is counted from the open `user_groups` rows.
- **Identity key is `Employee.employee_id`.** Sign-in is Google OAuth (there is no Entra integration in this app, so there is no `oid`); the employee id is the stable internal key, the e-mail is only used to find the row at sign-in.
- **One active group per employee** is enforced by the partial unique index `user_groups_one_active_per_employee_idx`. A change closes the old row (`effective_until`) and opens a new one, so history is kept.
- **No group / inactive group = default policy** (`lib/services/group-context.service.ts`): priority of the LOWEST active group, booking create/view/cancel only, may not preempt, no dashboard.
- **Permissions** (`lib/constants.ts` `PERMISSION`) are checked on the backend from the database on every request (`lib/permissions.ts`, booking service, cancel route, `/api/dashboard/*`), never by group name: `dashboard.view`, `booking.create`, `booking.view`, `booking.cancel`, `booking.priority` (may preempt).
- **Priority engine** (`lib/services/priority.service.ts`, called only from `booking.service.createBooking`): the organizer's current group priority is stored on each meeting (`group_id_at_booking`, `priority_at_booking`). A request may take a slot only if its group has `booking.priority` and EVERY overlapping confirmed meeting has a strictly larger stored priority and has not started; otherwise 409 and nothing changes. Preempted meetings become status `PREEMPTED` (6, final, does not hold the room) in the same transaction, with an append-only `booking_priority_history` row, an audit log entry and an e-mail to their attendees. The earlier meeting-type / role-boost ranking no longer decides bookings; meetings already in `PENDING_RESCHEDULE` still use the reschedule flow.
- **Audit tables are append-only** (`booking_priority_history`, `group_audit_logs`): a trigger rejects UPDATE/DELETE. Admin group changes are written to `group_audit_logs`.
- **Booking dashboard** (`/dashboard`, `/api/dashboard/bookings`, `/api/dashboard/report`): periods are inclusive wall-clock date strings in `APP_TIMEZONE` (`lib/report-period.ts`), the same filters drive the metrics, the table and the CSV / XLSX (exceljs) / PDF (pdfkit) downloads, which stream from the server in batches. Confirmed = Scheduled + Completed; meeting hours and active rooms count confirmed bookings only.
- **Group Management is a permission** (`group.manage`, migration 0030): the /admin/groups page and every `/api/admin/*` route call `requireGroupManagement()`, which re-reads the database on each request. The Admin *role* always has access (so administrators cannot lock themselves out); any other group needs the permission ticked. Navigation visibility is a convenience only.
- **Per-group controls** (migration 0031, all enforced server-side and re-read on every booking by `lib/services/booking-policy.service.ts`): rooms a group may book (`group_rooms`; no rows = every room), longest meeting / days ahead / occurrences per series (`group_settings`; null = no extra limit, limits only tighten the system ones), and the permissions `booking.recurring` (series) and `rooms.manage` (create/edit/delete rooms; the Admin role always may, like `group.manage`). People with no usable group have no extra limits. The booking form reads `/api/booking-policy` only to hide or limit options; it is not the control. The legacy reschedule path for meetings already in PENDING_RESCHEDULE does not apply these rules.
- **Entra sync settings** (`entra_sync_settings`, `entra_group_mappings`): an admin can switch automatic sync on (interval 1 hour to a week; the per-minute job starts a sync when the last attempt is older than the interval, one at a time) and map Entra security groups to app groups. A mapping is used only the FIRST time a person is synced and only if they have no group; several matches resolve to the highest priority group; inactive groups are ignored; everyone else still goes to the Employee group. Needs the Graph application permissions Group.Read.All (list groups) and GroupMember.Read.All (members; direct members only).
- **Replaced bookings**: stored as status `PREEMPTED` (6), shown everywhere as **Replaced** (`MEETING_STATUS_LABEL`); participants are shown as **Primary Invitee** (Participants field) or **Additional Invitee** (Optional Participants field), see `invitationCategory`. `lib/services/bump-info.service.ts` reads `booking_priority_history` to say who took the room (organizer, group, meeting title/type, room, date, time, reason). The dashboard lists bumped bookings (status filter, "Replaced" card, expandable details with the people invited to both meetings, and the reverse "this booking replaced…" panel, export columns) and My Bookings has a "Replaced Bookings" tab with an expandable panel; the bumped booking itself is never changed or deleted.
- **Participants**: `meeting_attendees.is_optional` marks optional participants. Both kinds get the invitation e-mail (optional ones are told so) with Accept / Decline; answers are tracked per person. An optional person's answer never affects the meeting, and nobody can be in both lists (checked by the validators, `createBooking` and the edit route).
- **Dashboard reports** contain the bookings AND the participants (separate "Participants" sheet in XLSX, separate table in PDF, second table in CSV), for every booking matching the active filters, not just the visible page.
- **Entra ID sync** (`lib/services/entra-sync.service.ts`, `/api/admin/employees/sync`, Employees tab): reads users with the app's own credentials (`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, application permission `User.Read.All`). `Employee.entra_object_id` is the identity (unique); an existing employee with the same e-mail is linked, never duplicated. Existing groups and roles are never changed; anyone with no active group is placed in the Employee group. Employees missing from the directory are kept. One sync runs at a time; every run is recorded in `employee_sync_runs`.
- **Room requests were removed** (page, API, e-mails, cron step). Their tables (`room_requests`, `room_request_holders`, `room_request_emails`) are kept as history and are no longer read or written; the priority/bump engine does not use them.
- **Rollback**: `drizzle/down/0027_groups_priority.down.sql`, `0028_participants_responses.down.sql`, `0029_group_types_entra_optional.down.sql` (manual; drizzle has no down migrations).
