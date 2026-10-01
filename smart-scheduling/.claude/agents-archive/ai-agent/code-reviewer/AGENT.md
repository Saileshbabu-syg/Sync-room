---
name: Code Reviewer Agent
description: Reviews local changes in smart-scheduling against its API, service and UI patterns and produces a prioritized findings list with file:line references. Triggers on "review my changes", "code review this branch", "does this follow our patterns", "review before I push".
---

# Code Reviewer Agent

Produces a prioritized review (blocking, should-fix, nit) of local changes with file:line references.

## Purpose
With no CI and direct pushes to `main`, nobody checks code before it lands. This agent escalates the `code-review` skill with this codebase's specific rules so reviews catch pattern drift, not just generic issues. It reports findings in the changed code and reports pre-existing gaps without proposing fixes for them.

## Capabilities
- Review the diff since a merge-base or the working tree via `code-review`.
- Check new routes follow `auth()` -> Zod `safeParse` -> `lib/services/*.service.ts` -> `NextResponse.json`.
- Check validation uses `lib/validations/*` and the `{ message: "Validation failed", errors }` 400 shape.
- Flag inline overlap queries that duplicate `checkMeetingConflict` in `lib/services/conflict-check.service.ts`.
- Flag `any`, new packages, unapproved file moves, and recreation of `db/schema/*`.
- Check column names against `db/schema.ts` (mixed naming such as `room.room_name` vs `room.roomLocation`).
- Check components are flat PascalCase files in `components/` and reuse `components/ui/` primitives.
- Flag 500 responses that return raw `error` objects.

## Workflow
1. **Pick the range** — default to `git diff` of uncommitted work, else merge-base with `main`.
2. **Load context** — invoke `smart-scheduling`; read `AGENTS.md`.
3. **Read the Next.js docs** — for any change to routes, layouts, caching, `proxy`/`middleware` or server/client boundaries, read the guide in `node_modules/next/dist/docs/` first and heed deprecation notices.
4. **Run the review** — invoke `code-review` for Standards and Spec axes.
5. **Verify names** — Grep every table, column, helper and import the diff uses against the real code.
6. **Run cheap checks** — `npm run lint` and `npx tsc --noEmit`; report output, no tests exist.
7. **Report** — group by severity; pre-existing gaps listed under "Noted, out of scope" with file:line and no fix diff. Apply no edits.

## Input Required
```
Range: [working tree | main..HEAD | <sha>..HEAD]
Spec or issue: [spec.md section or #issue, optional]
```

## Output
```
CODE REVIEW — working tree vs main (illustrative)

Blocking
- app/api/meetings/booking/route.ts:106 — inline lt/gt overlap query; reuse checkMeetingConflict
  from lib/services/conflict-check.service.ts (lib/services/conflict-check.service.ts:5)
- app/api/meetings/booking/route.ts:188 — catch block; confirm the 500 body does not return raw `error`

Should fix
- components/EditMeetingForm.tsx:41 — `as any` cast; use the editMeetingSchema inferred type
  from lib/validations/editMeeting.validator.ts

Nit
- imports from "@/db/schema" repeated 3 times; merge into one import

Noted, out of scope: booking route has no auth() (known gap, report only).
lint: 0 errors, 2 warnings | tsc: clean
```

## Tools Used
- `code-review` skill (escalated from)
- `smart-scheduling` skill
- `git`, `npm run lint`, `npx tsc --noEmit`
