@AGENTS.md

## Agents & Skills map

Ten agents live in `.claude/agents/<role>/<slug>/AGENT.md`; skills in `.claude/skills/`. The flow is in `.claude/agents/WORKFLOW.md`. Escalate skill first, then agent. Agents report pre-existing gaps and do not fix them unless asked. Code is hosted on GitHub (`gh`, Issues); CI is defined for Azure DevOps (`azure-pipelines.yml`), there are no GitHub Actions. Archived agents are in `.claude/agents-archive/` and are not loaded.

| Area | Skills | Agents |
|---|---|---|
| Auth (`auth.ts`, `lib/permissions.ts`, `lib/auth-helpers.ts`; no proxy/middleware, checks are per route and page) | `smart-scheduling` | `backend-agent/auth-guard` |
| DB / schema (`db/schema.ts`, drizzle-kit) | `domain-modeling`, `smart-scheduling` | `backend-agent/db-schema` |
| API routes (`app/api/**/route.ts`) | `implement-spec` | `backend-agent/api-route-builder` |
| Services (`lib/services/*`) | `codebase-design` | none |
| Components and forms | `implement` | none |
| Scheduling domain (conflicts, recurrence, ICS) | `smart-scheduling`, `diagnosing-bugs` | `scheduling-agent/conflict-check-guardian`, `recurring-meeting-builder`, `calendar-export-builder` |
| Cron / email | `diagnosing-bugs` | `scheduling-agent/reminder-notification` |
| Testing (`node:test` via tsx — see `tests/README.md`; no Vitest) | `tdd` | `qa-agent/test-tooling-proposer` |
| Security / env | `security-review` (built-in) | `devops-agent/security-scanner`, `devops-agent/env-auditor` |
| CI/CD (`azure-pipelines.yml`, not yet run in an Azure DevOps org; no deploy stage) | `wizard` | none |
| Git / PR | `pr`, `code-review`, `resolving-merge-conflicts` | none |
| Requirements / planning | `to-spec`, `to-tickets`, `triage`, `grilling` | none |
| Debug / docs / context | `diagnosing-bugs`, `handoff`, `writing-for-agents` | none |
