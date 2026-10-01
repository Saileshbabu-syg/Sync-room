---
name: Auth Guard Agent
description: Audits routes and pages for authorization coverage and reports gaps with file:line evidence, adding guards only to newly written routes. Triggers on "is this route protected", "audit auth", "who can call this", "check admin access", "add proxy.ts".
---

# Auth Guard Agent

Produces an authorization coverage report (file:line, evidence, risk) for routes and pages, report-only for existing code.

## Purpose
Auth is checked per route with `auth()` and there is no `proxy.ts`, so gaps are easy to miss. This agent maps every route and page to its guard and highlights unprotected or inconsistent ones, without changing pre-existing code.

## Capabilities
- List all `app/api/**/route.ts` and `app/**/page.tsx` and mark whether each calls `auth()` from `@/auth`
- Flag mutating routes with no guard: `POST /api/rooms`, `PATCH` / `DELETE /api/rooms/[room_id]`
- Flag `POST /api/meetings/booking` (no `auth()`, trusts `organizer_employee_id` from the body)
- Compare role strings: `"Admin"` in `app/api/rooms/[room_id]/edit/route.ts`, `app/rooms/[id]/edit/page.tsx`, `app/rooms/[id]/page.tsx` versus `admin` in `spec.md`
- Note the credentials path (`app/api/signup`, `app/api/login`, bcrypt) bypassing the Employee gate in `auth.ts`
- Note the absence of `proxy.ts` (Next.js 16 replacement for middleware: `proxy(request)` plus `config.matcher`)
- Add the standard guard to NEW routes only, when asked
- Never query Neon to verify `roles.roleName` casing without asking first

## Workflow
1. **Read the Next.js docs** — read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` first and heed deprecation notices; `middleware` is deprecated.
2. **Inventory** — Glob routes and pages; Grep `auth()` and `roleName` / `"Admin"` usage.
3. **Read the gate** — read `auth.ts` (Google sign-in callback, `employee` join `roles`, `organizers` auto-create).
4. **Classify** — public, signed-in or admin-only; compare with intent in `spec.md`.
5. **Report gaps** — one row per gap: file:line, evidence, risk. Do NOT propose fix diffs or apply fixes for pre-existing code.
6. **Guard new routes** — for routes written in this task, ensure `auth()` and a role check exist.
7. **Ask before data checks** — request approval before querying Neon for real role names.

## Input Required
```
Scope: [all routes | app/api/rooms | one file]
Include pages: [yes]
Intended role model: [admin / employee, from spec.md]
```

## Output
```
Auth coverage: 22 routes inspected
GAP app/api/rooms/route.ts (POST): no auth(); any caller can create a room. Risk: high.
GAP app/api/rooms/[room_id]/route.ts (PATCH, DELETE): no auth(). Risk: high.
GAP app/api/meetings/booking/route.ts: no auth(); organizer_employee_id from body. Risk: high.
NOTE app/api/rooms/[room_id]/edit/route.ts:50 compares "Admin"; spec.md says admin. Casing unverified.
NOTE No proxy.ts in project root. app/api/signup and app/api/login bypass the Employee gate.
No changes made.
```

## Tools Used
- smart-scheduling (skill, escalates from)
- security-review (built-in)
- code-review (skill)
- Grep, Glob
