# smart-scheduling: Agent & Skill Workflow

Ten agents live in `.claude/agents/<role>/<slug>/AGENT.md`. Everything else (planning, design, review, PRs, debugging, docs) is handled by the existing skills in `.claude/skills/`. Skill first, then agent. Platform is GitHub (`gh`, Issues, Actions).

Standing rules:
- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (`AGENTS.md`). `middleware` is now `proxy`.
- Agents **report** pre-existing gaps (file:line, evidence, risk). They do not fix them unless you ask.
- No new packages, no `any`, no moving files, no `db/schema/*`.
- Confirm before anything on shared Neon, deploys, CI changes, force-pushes, or deletions. Never print `.env` values.
- The team pushes to `main`. No branching convention is assumed.

## Phase flow

| Phase | Skills | Agents |
|---|---|---|
| 1. Discovery | `grilling`, `research` | none |
| 2. Design | `domain-modeling`, `codebase-design`, `prototype` | none |
| 3. Planning | `to-spec`, `to-tickets`, `triage` | none |
| 4. Implementation | `implement-spec`, `implement` | `db-schema`, `api-route-builder`, `auth-guard`, plus the scheduling group |
| 5. Testing | `tdd` | `test-tooling-proposer` (proposes only, installs nothing) |
| 6. Git & PR | `code-review`, `pr`, `resolving-merge-conflicts` | `security-scanner`, `env-auditor` |
| 7. Deployment | `wizard` | none. No CI/CD or hosting exists, so ask for a proposal when needed. |

## Agents

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|---|---|---|---|---|---|
| 4.1 | Agent | `backend-agent/db-schema` | "add a column" | Approved edit to `db/schema.ts` | 4.2 |
| 4.2 | Agent | `backend-agent/api-route-builder` | "new API route" | `app/api/**/route.ts` (auth, safeParse, service) | 4.3 |
| 4.3 | Agent | `backend-agent/auth-guard` | "is this route protected" | Auth coverage report, guard for new routes | 6.1 |
| 4.S1 | Agent | `scheduling-agent/conflict-check-guardian` | "audit conflict check" | Overlap and race report | 4.2 |
| 4.S2 | Agent | `scheduling-agent/recurring-meeting-builder` | "recurring meetings UI" | Recurring UI and API wiring | 6.1 |
| 4.S3 | Agent | `scheduling-agent/reminder-notification` | "reminder emails not sending" | Cron and nodemailer work | 6.1 |
| 4.S4 | Agent | `scheduling-agent/calendar-export-builder` | "export to calendar" | ICS export | 6.1 |
| 5.1 | Agent | `qa-agent/test-tooling-proposer` | "set up testing" | Vitest, Testing Library and Playwright proposal | `tdd` after approval |
| 6.1 | Agent | `devops-agent/security-scanner` | "security scan" | Route auth, secrets and `npm audit` report | 6.2 |
| 6.2 | Agent | `devops-agent/env-auditor` | "audit env vars" | Env key names vs code | PR |

## Skill → Agent quick reference

| Skill | Escalates to |
|---|---|
| `domain-modeling` | `db-schema` |
| `codebase-design`, `implement-spec`, `implement` | `api-route-builder`, `recurring-meeting-builder` |
| `diagnosing-bugs` | `conflict-check-guardian`, `reminder-notification`, `calendar-export-builder` |
| `tdd` | `test-tooling-proposer` |
| `security-review` (built-in) | `security-scanner`, `auth-guard` |
| `smart-scheduling` | Loaded by every agent for stack and known issues |

Planning, review, PRs, handoffs and docs have no agent. Use `to-spec`, `to-tickets`, `triage`, `code-review`, `pr`, `handoff` and `writing-for-agents` directly.

## Archived agents

The other 27 are in `.claude/agents-archive/` and are not loaded. Move a folder back into `.claude/agents/` to restore it.
