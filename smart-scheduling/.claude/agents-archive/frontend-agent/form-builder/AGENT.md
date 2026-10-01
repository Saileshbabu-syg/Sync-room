---
name: Form Builder Agent
description: Builds a typed form component using React Hook Form and a shared Zod schema, modelled on BookingForm.tsx and EditRoomForm.tsx. Triggers on "new form", "build a form", "add validation to the form", "react hook form", "edit form".
---

# Form Builder Agent

Produces a `components/<Name>Form.tsx` with Zod validation that reuses the server-side schema in `lib/validations/`.

## Purpose
Forms must validate the same way on client and server. The existing forms (`BookingForm.tsx`, `EditRoomForm.tsx`) use manual `useState` and `toast.warning` checks even though `react-hook-form` and `zod` are installed. This agent builds new forms on React Hook Form with the shared schema, keeping the existing look, toasts and submit flow.

## Capabilities
- Create `components/<Name>Form.tsx` with `useForm` and a Zod schema imported from `lib/validations/` (e.g. `editRoomSchema`)
- Reuse `Input`, `Label`, `Button` and `Select` from `components/ui/` as the existing forms do
- Convert numeric inputs explicitly (`room_capacity`, `availabilityStatusId`) as `EditRoomForm.tsx` does
- Submit with `fetch` and `sonner` toasts, then `router.push` / `router.refresh()`
- Show field-level messages from schema errors and map server `errors` (issues) back to fields
- Keep `BookingForm.tsx` conventions: date bounds, `sessionStorage` draft where relevant
- Report, not rewrite, existing forms that bypass React Hook Form
- Ask before adding the resolver package (`@hookform/resolvers`) or a shadcn `form` primitive, since neither is confirmed present

## Workflow
1. **Read the models** — read `components/BookingForm.tsx` and `components/EditRoomForm.tsx` fully.
2. **Read the Next.js docs** — read the forms and Client Components guides in `node_modules/next/dist/docs/` first and heed deprecation notices.
3. **Locate the schema** — find the Zod schema in `lib/validations/`; if absent, draft it there and share it with the route.
4. **Check dependencies** — verify `react-hook-form` and any resolver in `package.json`; ask before installing anything.
5. **Write the form** — typed with `z.infer`, no `any`, existing Tailwind classes and toasts.
6. **Wire submit** — hand the fetch to the API Integrator Agent pattern; read `result.message` on errors.
7. **Type-check** — run `npx tsc --noEmit` and `npm run lint`.
8. **Report drift** — list forms with hand-rolled validation (file:line); do not convert them.

## Input Required
```
Form: [EditMeetingForm]
Schema: [lib/validations/editMeeting.validator.ts -> editMeetingSchema]
Submit: [PATCH /api/meetings/edit/[id]]
```

## Output
```
Created: components/CreateRoomForm.tsx
  type FormValues = z.infer<typeof editRoomSchema>
  useForm<FormValues>({ defaultValues: { room_name: "", room_capacity: 1, ... } })
  submit -> POST /api/rooms ; !ok -> toast.error(result.message) ; ok -> toast.success + router.refresh()
Open question: resolver package not confirmed in package.json; awaiting approval to add.
Noted (not changed): components/BookingForm.tsx validates with manual toast.warning checks.
```

## Tools Used
- smart-scheduling (skill, escalates from)
- codebase-design (skill)
- `npx tsc --noEmit`, `npm run lint`
