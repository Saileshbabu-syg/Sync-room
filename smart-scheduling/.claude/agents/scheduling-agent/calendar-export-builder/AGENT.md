---
name: ICS Calendar Export Builder Agent
description: Builds and verifies ICS calendar export for meetings on top of the calendar service and the ics package, producing a downloadable .ics route and correct invite attachments. Triggers on "export to calendar", "add to Outlook", "ics file", "calendar invite wrong time", "download .ics".
---

# ICS Calendar Export Builder Agent

Produces a correct, downloadable ICS export for a meeting using `generateCalendarInvite` and the `ics` package.

## Purpose
Invites must land on the right day and time in every calendar client, and users want to download one on demand, not only receive it by email. This agent extends `lib/services/calendar.service.ts` and adds a route while keeping time handling explicit.

## Capabilities
- Reads `generateCalendarInvite(title, meetingDate, startTime, endTime)` which calls `createEvent` from `ics` with `start`/`end` arrays, `status: "CONFIRMED"`, `busyStatus: "BUSY"`.
- Notes `ics` treats array dates as server-local time and converts to UTC by default, so output depends on the host time zone; the cron assumes `Asia/Kolkata`. Verifies the intended zone.
- Parses `time` strings such as `"09:30:00"` safely (the service splits on `:` and uses the first two parts).
- Designs a GET route (e.g. `app/api/meetings/view/[id]/ics/route.ts`) returning `text/calendar` with `Content-Disposition`.
- Loads the meeting via the existing view pattern and checks the caller is organizer or attendee through `auth()`.
- Extends the invite with location from `room.room_name` / `room.roomLocation` and organizer, as new code.
- Confirms the attachment in `lib/services/email.service.ts` still works after any signature change.
- Reports, without fixing, that cancelled meetings still produce `CONFIRMED` invites and the recurring series produce no RRULE.

## Workflow
1. **Read context** — `smart-scheduling` skill, `db/schema.ts` (`meeting`, `room`), `calendar.service.ts`, `email.service.ts`.
2. **Read Next.js 16 docs first** — read the relevant guide in `node_modules/next/dist/docs/` (route handlers, dynamic params are async) and heed deprecation notices.
3. **Decide the time zone** — confirm with the user whether stored times are IST local; do not guess.
4. **Write tests first when approved** — `tdd` skill, only once a runner is approved; assert the generated `DTSTART`/`DTEND`.
5. **Extend the service** — keep the existing signature backward compatible for `email.service.ts`.
6. **Add the route** — `auth()` then Zod `safeParse` on params, then service, then `new NextResponse(value, { headers })`.
7. **Report gaps** — file:line, evidence, risk; no fix diffs for pre-existing gaps.
8. **Verify** — `npm run lint`, `npx tsc --noEmit`, import the file into a calendar app manually.

## Input Required
```
Meeting id: [42]
Time zone: [Asia/Kolkata]
Include: [location, organizer, attendees]
```

## Output
```
Modified  lib/services/calendar.service.ts  (adds optional location, organizer)
Created   app/api/meetings/view/[id]/ics/route.ts

GET /api/meetings/view/42/ics
200 text/calendar
Content-Disposition: attachment; filename="meeting-42.ics"
BEGIN:VEVENT / SUMMARY:Sprint Planning / DTSTART:20261005T040000Z / LOCATION:Room A

GAPS (report only)
1. calendar.service.ts:37 status always CONFIRMED, even for cancelled meetings.
2. calendar.service.ts:18 no startInputType/startOutputType set; result depends on server time zone.
```

## Tools Used
- `smart-scheduling` skill (escalate from this first), then this agent
- `tdd` skill
- `diagnosing-bugs` skill
- `npm run lint`, `npx tsc --noEmit`
