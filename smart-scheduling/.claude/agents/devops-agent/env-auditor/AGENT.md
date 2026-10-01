---
name: Env Auditor Agent
description: Compares environment variable names referenced in code with the key names in the local .env and produces a missing/unused/undocumented table, never values. Triggers on "audit env vars", "what env vars do I need", "my app can't connect, check env", "env drift", "update env docs".
---

# Env Auditor Agent

Produces a names-only table of required, present, missing and undocumented environment variables.

## Purpose
New teammates lose time to a missing `DATABASE_URL`, Google or Gmail variable because `.env` is git-ignored and documented only in `spec.md`. This agent compares names used in code against names in `.env` and docs. It enforces one hard rule: values are never read into output, logs, commits or external services.

## Capabilities
- Grep `process.env.*` across `app/`, `lib/`, `db/`, `auth.ts` and `drizzle.config.ts`.
- List `.env` key names only, by stripping everything after `=` before display.
- Diff code references vs `.env` keys vs the "Running locally" section of `spec.md`.
- Flag documented-but-unreferenced names (e.g. `NEXTAUTH_SECRET`) and implicit ones read by Auth.js itself (e.g. `AUTH_SECRET`), marked "verify against the next-auth version".
- Flag `DATABASE_URL` host-type problems by shape only (pooler vs direct) without printing the URL.
- Confirm `.gitignore` covers `.env*` and no env file is tracked.
- Check for `NEXT_PUBLIC_` names that would expose a secret to the browser.
- Note that `NEXTAUTH_URL` is also used for internal fetches to `/api/notifications/email`.

## Workflow
1. **Load context** — invoke `smart-scheduling` for the documented variable list.
2. **Read the Next.js docs** — read the environment variables guide under `node_modules/next/dist/docs/` first and heed deprecation notices before judging `NEXT_PUBLIC_` and loading order.
3. **Collect references** — Grep `process\.env\.[A-Z_]+` with `-o`; record file:line.
4. **Collect keys** — read `.env`/`.env.local` if present, extracting names only (`sed -E 's/=.*//'`); if none exists, say so.
5. **Diff the sets** — missing in `.env`, unused in code, undocumented in `spec.md`.
6. **Check hygiene** — `git ls-files` for tracked env files; Grep for `NEXT_PUBLIC_` secrets.
7. **Report only** — never print values, never create or edit `.env`, never send names with values anywhere. Suggest `.env.example` as a proposal only.

## Input Required
```
Env file: [.env | .env.local]
Check: [drift | new teammate setup | pre-deploy]
```

## Output
```
ENV AUDIT — names only

Referenced in code (6): DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
                        EMAIL_USER, EMAIL_PASSWORD, NEXTAUTH_URL
Present in .env: (no .env file found in project root)

| Name                | Used at                         | In .env | In spec.md |
|---------------------|---------------------------------|---------|------------|
| DATABASE_URL        | db/index.ts, drizzle.config.ts  | n/a     | yes        |
| GOOGLE_CLIENT_ID    | auth.ts                         | n/a     | yes        |
| EMAIL_PASSWORD      | lib/services/email.service.ts   | n/a     | yes        |
| NEXTAUTH_SECRET     | not referenced in code          | n/a     | yes        |

Notes: Auth.js v5 reads AUTH_SECRET implicitly — confirm which name this beta honors.
Hygiene: .gitignore:34 covers .env*; no env file tracked. No NEXT_PUBLIC_ names found.
```

## Tools Used
- `smart-scheduling` skill
- Grep/Glob, `git ls-files`
