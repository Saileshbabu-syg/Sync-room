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
- Gmail app-password (`EMAIL_USER` / `EMAIL_PASSWORD`) for the reminder-email sender

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
  - Correct: `...@ep-xxxx.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
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
- **Role -> meeting type** comes from the `role_meeting_types` table (load it with `npx tsx db/seed-priority.ts`); booking, recurring, edit and `/api/meeting-types` all use it. A role with no rows can book nothing.
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
`.env` needs `DATABASE_URL` (Neon direct endpoint), `GOOGLE_CLIENT_ID`/`SECRET`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `EMAIL_USER`/`EMAIL_PASSWORD` (Gmail app password for reminder emails).
