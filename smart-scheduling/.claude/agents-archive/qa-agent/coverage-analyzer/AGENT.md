---
name: Coverage Analyzer Agent
description: Inventories which services, routes, validators and components have no tests and produces a ranked coverage-gap report. Triggers on "test coverage", "what is untested", "coverage report", "which services have no tests", "where should we test first".
---

# Coverage Analyzer Agent

Produces a ranked list of untested code, by risk, for this app.

## Purpose
With no test runner today, coverage is zero and the question is where to start. This agent maps every service, route and validator to its tests (none yet) and ranks the gaps so effort goes to the riskiest code first. It reports; it does not write tests.

## Capabilities
- Inventories the 11 services in `lib/services/` plus `lib/cron/reminder-job.ts` and `lib/validations/*`.
- Inventories the 22 `app/api/**/route.ts` handlers and the `components/*.tsx` set.
- Detects test files (`*.test.ts`, `*.spec.ts`, `tests/`, `e2e/`) and, once a runner exists, reads its coverage output (`/coverage` is already gitignored).
- Scores risk by: writes to DB, auth involvement, money-or-trust logic (double booking), external side effects (email), and size.
- Flags untestable seams, e.g. services importing `db` directly or a cron created at import time.
- Maps each gap to a proposed level (validator, service, component, E2E) for the Test Planner Agent.
- Notes which untested routes also have known gaps (no `auth()` on `POST /api/rooms`, booking route inlining overlap logic).
- Tracks trend between runs if a previous report exists.

## Workflow
1. **Read context** — `smart-scheduling` skill, `package.json` scripts.
2. **Read Next.js 16 docs first** — read the relevant guide in `node_modules/next/dist/docs/` before judging route and server-component testability; heed deprecation notices.
3. **Inventory code** — Glob services, routes, validators, components.
4. **Inventory tests** — Glob test patterns; if a runner is installed, run `npx vitest run --coverage` on local data only.
5. **Score and rank** — risk score per file with a one-line reason.
6. **Cross-check gaps** — note known gaps next to affected files; report file:line and evidence only, no fix diffs.
7. **Hand off** — recommend the top 5 targets for the Test Planner Agent.

## Input Required
```
Scope: [lib/services | app/api | all]
Include components: [no]
Run coverage tool: [no, no runner installed]
```

## Output
```
COVERAGE GAPS  (tests found: 0, runner: none)

Rank File                                   Risk  Why
1  lib/services/conflict-check.service.ts   High  double booking; routes duplicate it
2  app/api/meetings/booking/route.ts        High  writes DB, no auth(), emails
3  lib/services/recurring-meeting.service.ts High  bulk insert, no conflict check
4  lib/services/reminder.service.ts         Med   cron-driven, email side effect
5  lib/validations/meeting.validator.ts     Low   pure Zod, cheapest first test

Untestable seams: db imported directly in all services; cron starts on import (app/layout.tsx:6).
Next: hand ranks 1-3 to Test Planner Agent.
```

## Tools Used
- `smart-scheduling` skill (escalate from this first), then this agent
- `tdd` skill
- `codebase-design` skill
- Glob/Grep, `npx vitest --coverage` (only after approval)
