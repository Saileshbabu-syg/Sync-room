# smart-scheduling

An internal meeting-room booking app: employees book rooms for meetings, admins manage the room inventory. Built with Next.js 16 (App Router), Drizzle ORM + Postgres (Neon), NextAuth v5 (Google OAuth), node-cron for email reminders, Tailwind/shadcn UI.

**Status: local development only** — not deployed anywhere yet. Everyone runs their own `npm run dev` against the shared Neon database.

## Project structure

- `app/` — pages and API routes (App Router). Key folders: `booking/`, `bookings/` (edit/cancel), `dashboard/`, `rooms/`, `login/`, `signup/`, `api/` (all backend routes).
- `db/schema/` — Drizzle table definitions, one file per table.
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
- A `docker-compose.yml` exists for spinning up a **local** Postgres container as a fallback/offline option (`docker compose up -d`), matching the schema via `npx drizzle-kit push`. Not used for day-to-day team work — Neon is the shared source of truth.
- Schema lives in `db/schema/*.ts`. Apply changes with `npx drizzle-kit push`.

## Roles

Only two roles exist: `admin` and `employee`.
- **Admin**: manages rooms (create/edit/delete), can also book rooms.
- **Employee**: can only book rooms.

Meeting types are simplified to in-person only concepts: e.g. `Team Meeting`, `Interview` (no virtual meeting type needed).

## Auth model

- `auth.ts`: Google OAuth via NextAuth. Sign-in is gated — the user's email must already exist in the `Employee` table (joined to `roles`), or login is rejected with `/login?error=not-authorized`. There is **no self-signup** — new employees must be added to the `Employee` table directly (no admin UI for this exists yet).
- On first successful sign-in, an `Organizer` row is auto-created from the `Employee`/`roles` data.

## Known issues / gaps (read before assuming something works)

- **Room management API routes are inconsistently protected.** Only `PATCH /api/rooms/[room_id]/edit` checks `organizer.role === "Admin"`. `POST /api/rooms` (create), and both `PATCH`/`DELETE` on `/api/rooms/[room_id]` (a separate, duplicate update path) have **no auth check at all** — any request can create/update/delete rooms. This needs the same admin check added before relying on room permissions being enforced.
- **Leftover credentials-based auth path** (`app/api/signup`, `app/api/login`, bcrypt password on `Organizer`) bypasses the `Employee` table gate entirely. Dead/inconsistent with the canonical Google-only flow in `auth.ts` — should be removed or reconciled, not used.
- **No route-level middleware** (`middleware.ts` doesn't exist) — authorization is ad-hoc per API route, not centrally enforced.
- **No DB-level conflict prevention** for room double-booking — only checked in `lib/services/conflict-check.service.ts` at the application layer. Concurrent requests can race past this.
- **`recurring_meetings` table + service exist but no UI calls them** — feature is backend-only/unreachable currently.
- **No employee management UI** — since login requires a pre-existing `Employee` row, there's currently no way to onboard a new teammate except inserting directly into the DB.
- **No test suite** exists in the repo.
- **`lib/cron/reminder-job.ts`** (the reminder email cron) is imported as a side-effect in `app/layout.tsx`. In dev, Next.js lazily compiles routes, so the cron doesn't actually start ticking until the first page request hits the server — not a bug, just a quirk to know about when debugging "why isn't the cron running yet."

## Running locally

```bash
npm install
npm run dev
```
`.env` needs `DATABASE_URL` (Neon direct endpoint), `GOOGLE_CLIENT_ID`/`SECRET`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `EMAIL_USER`/`EMAIL_PASSWORD` (Gmail app password for reminder emails).
