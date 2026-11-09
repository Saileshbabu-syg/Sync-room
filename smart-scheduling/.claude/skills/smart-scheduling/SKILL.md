---
name: smart-scheduling
description: Project context for the smart-scheduling meeting room booking app - stack, database setup, auth model, and known issues. Load when working on this repo.
---

# smart-scheduling

Next.js 16 (App Router) meeting-room scheduler. Drizzle ORM + Postgres (Neon), NextAuth v5 (Google OAuth), node-cron for email reminders, Tailwind/shadcn UI.

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

- `auth.ts`: Google OAuth via NextAuth. Sign-in is gated — the user's email must already exist in the `Employee` table (joined to `roles`), or login is rejected with `/login?error=not-authorized`. There is **no self-signup** — new employees must be added to the `Employee` table directly or created by Entra ID sync (Group Management → Employees); there is no form to add one by hand.
- On first successful sign-in, an `Organizer` row is auto-created from the `Employee`/`roles` data.

## Known issues / gaps (read before assuming something works)

- **Room management routes** (`POST /api/rooms`, `PATCH`/`DELETE /api/rooms/[room_id]`, `PATCH /api/rooms/[room_id]/edit`) all require `canManageRooms`. Two PATCH paths exist for the same room; the UI uses only `/edit`.
- **Leftover `Organizer.password` column and unused `bcrypt` dependency** from a removed credentials login; `app/api/signup` and `app/api/login` no longer exist.
- **No route-level middleware** (`middleware.ts`/`proxy.ts` don't exist) — authorization is checked in each API route and page.
- **Double-booking is prevented in the database** by the `meeting_no_room_overlap` EXCLUDE constraint plus a per-room advisory lock in `lib/services/booking.service.ts`.
- **Recurring meetings** are bookable from the booking form; there is no series-level edit or cancel.
- **No form to add an employee by hand** — employees come from Entra ID sync (Group Management → Employees) or a direct DB insert.
- **Tests** live in `tests/` (`node:test`; see `tests/README.md`).
- **`lib/cron/reminder-job.ts`** is started from `instrumentation.ts` when the server boots (`REMINDER_CRON_ENABLED=false` turns it off).

## Running locally

```bash
npm install
npm run dev
```
`.env` needs `DATABASE_URL` (Neon direct endpoint), `GOOGLE_CLIENT_ID`/`SECRET`, `AUTH_URL`, `AUTH_SECRET` (`NEXTAUTH_*` still read as a fallback), `EMAIL_FROM` and `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` if the relay needs them). `EMAIL_USER`/`EMAIL_PASSWORD` are no longer read. See `.env.example` and `DEPLOYMENT.md`.
