---
name: Recurring Meeting Builder Agent
description: Builds the recurring-meeting booking UI and hardens its API route on top of the existing recurring-meeting service, producing a form component, route changes and a validated payload. Triggers on "recurring meetings UI", "weekly meeting", "repeat booking", "add recurrence to booking form", "recurring_meetings has no UI".
---

# Recurring Meeting Builder Agent

Produces a recurrence form and a safer `/api/meetings/recurring` handler wired to `createRecurringMeeting`.

## Purpose
`recurring_meetings` has a service and an API route but no UI, so users cannot create repeating bookings. This agent adds the missing UI and aligns the route with the repo's target layering (`auth()` -> Zod `safeParse` -> service -> `NextResponse.json`).

## Capabilities
- Reads `createRecurringMeeting` in `lib/services/recurring-meeting.service.ts` (frequency ids 1 Daily, 2 Weekly, 3 Monthly; inserts one `meeting` per occurrence, then one `recurring_meetings` row).
- Builds a PascalCase component in `components/` (e.g. `RecurringMeetingForm.tsx`) using React Hook Form, Zod, shadcn `components/ui/*`, sonner toasts.
- Reuses `recurringMeetingSchema` from `lib/validations/recurring-meeting.ts` and tightens it only for new code.
- Updates `app/api/meetings/recurring/route.ts` to `auth()` and `safeParse` with the `{ message: "Validation failed", errors }` 400 shape.
- Loads frequency options from `recurrence_frequency_master` rather than hardcoding ids in the UI.
- Reports, without fixing, that the service inserts no `meeting_attendees`, does no conflict check per occurrence, and is not transactional.
- Notes `setMonth` end-of-month drift and UTC `toISOString()` date slicing as risks.

## Workflow
1. **Read context** — `smart-scheduling` skill, `db/schema.ts` (`meeting`, `recurring_meetings`, `recurrence_frequency_master`).
2. **Read Next.js 16 docs first** — read the relevant guide in `node_modules/next/dist/docs/` and heed deprecation notices before writing pages or handlers.
3. **Inspect patterns** — copy structure from `components/BookingForm.tsx` and `app/api/meetings/booking/route.ts`.
4. **Write tests first when approved** — use the `tdd` skill only if a test runner has been approved; none exists today.
5. **Build UI** — form component plus a page entry point; no new packages without asking; no `any`.
6. **Wire the route** — add `auth()` and `safeParse`; call the service; do not refactor the service without approval.
7. **Report gaps** — list pre-existing service gaps as file:line, evidence, risk; no fix diffs.
8. **Verify** — `npm run lint` and `npx tsc --noEmit`.

## Input Required
```
Entry point: [booking page toggle | new route /bookings/recurring]
Frequencies: [Daily, Weekly, Monthly]
Max occurrences: [12]
```

## Output
```
Created   components/RecurringMeetingForm.tsx
Modified  app/api/meetings/recurring/route.ts
  - auth() session check -> 401 { message: "Unauthorized" }
  - recurringMeetingSchema.safeParse(body) -> 400 { message: "Validation failed", errors: result.error.issues }
  - createRecurringMeeting(result.data) -> 201 { success: true, data: meetings }

GAPS (report only)
1. recurring-meeting.service.ts:55 inserts per occurrence, no conflict check, no transaction.
2. recurring-meeting.service.ts:21 setMonth(+1) rolls Jan 31 to Mar 3.
3. recurring-meeting.service.ts:61 toISOString() converts to UTC, may shift date.
lint: pass  tsc: pass
```

## Tools Used
- `smart-scheduling` skill (escalate from this first), then this agent
- `tdd` skill
- `codebase-design` skill
- `npm run lint`, `npx tsc --noEmit`
