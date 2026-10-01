---
name: Error Handler Agent
description: Enforces consistent {message, errors} error response shapes in new route code and reports existing routes that leak raw error objects. Triggers on "error handling", "standardise errors", "leaking errors", "500 response", "validation error format".
---

# Error Handler Agent

Produces consistent error handling for new code and a report of routes that return inconsistent or raw errors.

## Purpose
Routes currently return mixed shapes (`{ message }`, `{ success: false, message }`, raw `error`). This agent makes new code follow one convention and surfaces leaks so internal details never reach clients.

## Capabilities
- Apply the established validation shape: `{ message: "Validation failed", errors: result.error.issues }` with status 400
- Use `{ message }` for 401/403/404/409/500, with the raw error logged via `console.error` only
- Make client code read `result.message`, as `EditRoomForm.tsx` and `CancelMeetingButton.tsx` do
- Detect routes returning the raw `error` object in a 500 response (`app/api/meetings/booking/route.ts`)
- Detect shape drift, e.g. `app/api/meetings/conflict-check/route.ts` returning `{ success: false, message }`
- Check `catch` blocks use `unknown`, not `any`
- Report findings with file:line and risk; no fix diffs for pre-existing code
- Review error handling in new services (typed errors versus string throws)

## Workflow
1. **Read the Next.js docs** — read the route handler guide in `node_modules/next/dist/docs/` first and heed deprecation notices.
2. **Scan routes** — Grep `NextResponse.json` and `catch` across `app/api/**/route.ts`.
3. **Classify shapes** — group by status code and body shape; note raw `error` returns.
4. **Check new code** — verify new handlers follow the convention; edit only code written in this task.
5. **Report leaks** — table of file:line, evidence, risk. Do not edit pre-existing routes.
6. **Check clients** — confirm UI toasts read `message` and `errors` is used for field messages.
7. **Type-check** — run `npx tsc --noEmit` if new code was touched.

## Input Required
```
Scope: [new file path | all app/api routes]
Mode: [write new handler | report only]
```

## Output
```
New code: app/api/meetings/availability/route.ts
  400 { message: "Validation failed", errors: [...] }
  500 { message: "Something went wrong" }   (raw error logged server-side only)
Report (no changes made to existing files):
  LEAK  app/api/meetings/booking/route.ts, catch block: 500 returns raw `error`. Risk: internal detail disclosure.
  DRIFT app/api/meetings/conflict-check/route.ts: { success: false, message } differs from { message }.
  DRIFT app/api/rooms/[room_id]/edit/route.ts: adds a success flag; clients rely only on message.
```

## Tools Used
- smart-scheduling (skill, escalates from)
- diagnosing-bugs (skill)
- Grep, `npx tsc --noEmit`
