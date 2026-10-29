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
| `EMAIL_FROM` | set | dummy | **required**, one address |
| `SMTP_HOST` / `SMTP_PORT` | relay or local sink | local sink | **required** |
| `SMTP_USER` / `SMTP_PASSWORD` | if relay needs auth | unset | if relay needs auth |
| `SMTP_SECURE` | optional | n/a | optional (see 4) |
| `SMTP_ALLOW_INSECURE` | dev sink only | harness only | **never** |
| `TRUST_PROXY_HEADERS` | n/a | n/a | only without `AUTH_URL` (see 3) |
| `REMINDER_CRON_ENABLED` | default on | `false` | `false` on all but one instance if you want a single scheduler |
| `REMINDER_LEAD_MINUTES` | default 15 | n/a | integer only |
| `INTERNAL_API_SECRET` | unset | n/a | unset unless `/api/notifications/email` is wanted |

At boot (production only) the server logs one line per configuration problem
for e-mail and Auth.js (`E-mail configuration: ...`, `Auth configuration: ...`).
Messages name variables, never values. Bookings keep working with bad mail
config; their e-mails stay queued and are retried once it is fixed.

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

## 4. E-mail

All booking e-mail (new booking, recurring series, update, cancellation,
reminder) goes through `lib/services/email.service.ts`: one transport, one
sender (`EMAIL_FROM`). Recurring confirmations list every confirmed occurrence
with its date and time. Delivery is queued in the database and retried.

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
- Several instances are safe: rows are claimed with `FOR UPDATE SKIP LOCKED`,
  there is a unique reminder per meeting, and a sent reminder is marked SENT in
  the same transaction. Delivery is **at-least-once**: if a process dies after
  the mail relay accepts a message but before the commit, that reminder can be
  sent again on retry.
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
organisation. It uses Node 22, `npm ci`, and a throw-away `postgres:16-alpine`
service container whose database is `ss_test_main` (the test safety guard
accepts only a local `ss_test_*` database). Steps, all of which fail the build:
typecheck, lint, unit tests, production dependency audit (high or above),
database tests, build, end-to-end tests. Add the secret variable
`CI_POSTGRES_PASSWORD` in Azure DevOps first. The file lives in `smart-scheduling/`;
point the pipeline at that path (or move it to the repository root).

## 10. Known limitations and owner decisions

- Hosting provider, hostname, SMTP relay, secret store and packaging are
  undecided; production Google redirect URI and `AUTH_URL` depend on the hostname.
- Auth.js v5 is still a beta release (the patched line available today).
- Database-backed and end-to-end suites have **not been executed** in the
  environment this change was prepared in (no PostgreSQL/Docker available);
  CI will be their first run.
- Git history still contains the old local password (see section 6).
- `REMINDER_LEAD_MINUTES` is parsed with `Number()`; a non-numeric value breaks
  reminder creation. Keep it an integer.
- Rate limiting covers only the authenticated booking/edit/cancel/suggestion
  APIs and is in process memory (per instance, not shared). Sign-in endpoints
  are not rate limited by the app; use the reverse proxy / WAF if needed.
