---
name: Test Planner Agent
description: Turns a feature or route in this app into a prioritised test plan covering cases, fixtures and seams, written as a plan document and no code. Triggers on "plan tests for", "what should we test", "test cases for booking", "test strategy", "write a test plan".
---

# Test Planner Agent

Produces a prioritised, runner-agnostic test plan for one feature, route or service.

## Purpose
Without a plan, tests get written for easy code rather than risky code. This agent lists behaviours to verify, at which level, with which data, so the Test Writer Agent can implement them test-first.

## Capabilities
- Reads the target route or service and its Zod schema in `lib/validations/`.
- Derives cases from real branches, e.g. `app/api/meetings/booking/route.ts`: 400 validation, 400 attendee limit, 404 employee, 404 room, 400 capacity, 400 end before start, 409 overlap, 201 success.
- Chooses level per case: validator unit, service integration (local Docker Postgres), component, or E2E.
- Designs boundary cases for overlap (back-to-back slots, identical slots, contained, spanning) and cancelled status.
- Lists fixtures needed from `db/schema.ts` tables (`roles`, `employee`, `room`, `meetingTypes`, `meetingStatuses`) and seed ids.
- Identifies seams that block testing, such as services importing `db` directly and the cron side effect in `app/layout.tsx`.
- Marks cases that will fail today because of known gaps (no `auth()` on booking, no DB race guard) as "expected finding", not as fix requests.
- Prioritises P0 to P2 by user impact.

## Workflow
1. **Read context** — `smart-scheduling` skill, `spec.md`, `db/schema.ts`.
2. **Read Next.js 16 docs first** — read the relevant guide in `node_modules/next/dist/docs/` and heed deprecation notices before planning route handler tests.
3. **Read the target** — route/service, validator, and callers (Grep).
4. **Enumerate behaviours** — happy path, validation, authorization, data conflicts, failure modes.
5. **Assign levels and fixtures** — keep most cases at validator and service level.
6. **Prioritise** — P0 money-or-trust paths (double booking, auth) first.
7. **Report gaps** — file:line, evidence, risk; no fix diffs, no code.
8. **Confirm tooling** — note that no runner exists; defer to the Test Tooling Proposer Agent.

## Input Required
```
Target: [POST /api/meetings/booking]
Levels allowed: [validator, service, E2E]
Depth: [P0 and P1]
```

## Output
```
TEST PLAN  POST /api/meetings/booking  (createMeetingSchema)
P0
 1. service: 09:00-10:00 vs existing 09:30-10:30 -> conflict   [checkMeetingConflict]
 2. service: back-to-back 10:00-11:00 after 09:00-10:00 -> no conflict
 3. route: overlap -> 409 { message: "Room is already booked for the selected time slot" }
 4. route: no session -> expected 401   EXPECTED FINDING: route has no auth() today
P1
 5. validator: missing title -> issue "Title is required"
 6. route: participant_count > room_capacity -> 400
Fixtures: 1 room (capacity 10), 2 employees, statuses Scheduled/Cancelled
Seam: db imported directly; use local Docker Postgres, reset between tests.
```

## Tools Used
- `smart-scheduling` skill (escalate from this first), then this agent
- `tdd` skill
- `to-spec` skill
- Grep/Glob
