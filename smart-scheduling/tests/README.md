# Tests

Built on Node's own test runner (`node:test`) executed through the `tsx` that is
already a dev dependency — no extra framework or package.

| Command | What it runs | Needs |
|---|---|---|
| `npm run test:unit` | pure logic: time/overlap rules, validators, e-mail escaping, API helpers, rate limiter | nothing |
| `npm run test:db` | booking service, concurrency, role rules, reminders/audit/notifications, identity, migrations | isolated local Postgres |
| `npm run test:e2e` | the production build over real HTTP: auth matrix, authorization, pages, booking API, SMTP sink | local Postgres + `npm run build:test` |
| `npm test` | unit + db | |
| `npm run test:all` | everything | |

## One-time setup

1. A local Postgres (the repo's `docker compose up -d` container works).
2. Create a database whose name starts with `ss_test_` (e.g. `CREATE DATABASE ss_test_main;`).
3. Create `smart-scheduling/.env.test` (git-ignored):

```
TEST_ADMIN_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/postgres
TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/ss_test_main
```

`tests/helpers/safety.ts` **aborts the run** unless `TEST_DATABASE_URL` is on
localhost and the database name matches `ss_test_*`. There is no fallback to
`DATABASE_URL`; the real `.env` is never read by tests (`tests/setup.ts` points
dotenv at a non-existent file), and mail credentials are replaced with dummies.

## Mail

Nothing is ever sent. Unit/db tests swap in an in-memory JSON transport
(`captureMail`); the HTTP tests start the app with `SMTP_HOST` pointing at a
tiny local SMTP sink (`tests/helpers/smtp-sink.ts`).

## Notes

- `test:db` and `test:e2e` run files one at a time (`--test-concurrency=1`) and
  truncate the test database's tables — it is a throw-away database.
- The migration tests create and drop their own `ss_test_mig_*` databases.
- `build:test` runs `next build` with the test environment (so a build can never
  see the real `.env` database URL).
