# Planned production architecture (Azure, Entra ID, Microsoft Teams)

**Status: a plan, not a description of the running system.** Nothing in sections 3
to 6 is implemented, deployed or validated. The application is a proof of
concept. Being compatible with these plans is not the same as being ready for
production, and section 8 lists what stands between the two.

What the application does today is in `ARCHITECTURE.md`; operating it, its
environment variables and its validation status are in `DEPLOYMENT.md`.

## 1. Current POC architecture (for reference)

- One Next.js 16 server process, PostgreSQL through Drizzle, services in
  `lib/services/*` shared by pages and `app/api/**` route handlers.
- **Sign-in:** Auth.js v5 with Google OAuth. The verified e-mail must match an
  active `Employee` row. Sessions are 12-hour JWT cookies (`SameSite=Lax`).
- **Authorization is the application's own:** the `Employee` role (Admin or not),
  one active group per employee, and group permissions, booking policies, rooms
  and meeting types stored in the database. It is re-read on every request.
- **Entra today:** an optional directory *sync* (application permission
  `User.Read.All`) creates and deactivates `Employee` rows and stores the Entra
  Object ID in `Employee.entra_object_id` (unique). New people get the default
  role and the default group; existing roles and groups are never touched, and
  nothing is granted from an Entra role, job title or group name.
- **Teams today:** optional Teams *online meeting* creation through Microsoft
  Graph with an application permission, run by a background worker. Not yet
  validated in a real tenant (`DEPLOYMENT.md` section 9a).
- **Environments:** local Docker PostgreSQL for development, a hosted PostgreSQL
  for shared testing. Configuration is environment variables only (`.env`,
  `.env.local`, `.env.test`; none committed). The one localhost default in code is
  the e-mail link base (`lib/invitation-token.ts`), which the production boot
  check flags when `AUTH_URL` is missing.

## 2. Principles that every later step must keep

1. **The booking engine is reused, never copied.** Booking, rescheduling,
   recurring series, policies, priority and notifications live in
   `lib/services`. A Teams interface, an API client or a bot calls the same
   functions (through the same route handlers) and never re-implements a rule.
2. **Identity and authorization stay separate.** Entra ID proves who someone is.
   The application decides what they may do. No Entra role name, job title,
   group or app role grants an application permission. Admin stays an
   application role that an administrator assigns.
3. **The web application keeps working without Teams**, and local development
   keeps working without Azure or Entra. Enterprise sign-in is added as another
   provider chosen by configuration; Google and the test setup are not removed
   until a deliberate decision.
4. **Environment-specific values are configuration, not code.** No credentials,
   hosts or URLs in source.
5. **Least privilege and secure tokens.** Only the Graph permissions a feature
   needs, tokens handled on the server, secrets outside the repository.

## 3. Planned Azure hosting architecture

| Concern | Plan | Notes |
|---|---|---|
| Web host | Azure App Service (Linux, Node 22) running `next start`; a container host is an alternative | Single deployable, as today. |
| Database | Azure Database for PostgreSQL, flexible server, TLS with `sslmode=verify-full`, private networking where the tenant requires it | Connection URL today; see section 8 for pooling and Entra database sign-in. |
| Secrets | Azure Key Vault, exposed to the app as Key Vault references in App Service settings | The application reads environment variables only, so no code change is needed for this. |
| Identity of the app | System-assigned managed identity to read Key Vault | Used for Key Vault first. Database and Graph use need separate evaluation. |
| CI/CD | Azure DevOps: the existing `azure-pipelines.yml` verify job (typecheck, lint, migration consistency, unit, database and end-to-end tests, build, audit), plus a deploy stage that does not exist yet | Migrations stay an explicit, reviewed deploy step, never at boot. |
| Monitoring | Application Insights and platform logs | The app logs with `console.*` today; structured logging is future work. |
| Scheduler | Exactly one instance runs the in-process reminder and worker jobs (`REMINDER_CRON_ENABLED=false` on the others), or the jobs move to a separate job | Required before scaling out. |
| Configuration | App settings per environment (dev, test, production), separate databases, no shared credentials | Never point a developer machine at the production database. |

Required configuration for any hosted environment is in `DEPLOYMENT.md` section 2
(`AUTH_URL`, `AUTH_SECRET`, the provider credentials, `DATABASE_URL`, mail).

## 3a. What is deliberately not planned yet

No other Azure services (queues, Service Bus, Functions, Front Door, API
Management) until a measured need exists.

## 4. Planned Microsoft Entra ID authentication

**Goal:** employees sign in with their organization account. The application's
own model still decides every permission.

- **Provider:** the Auth.js Microsoft Entra ID provider, limited to the
  organization's single tenant, added beside the Google provider. Which provider
  is offered is chosen by environment configuration. The exact provider and
  option names must be checked against the installed Auth.js version before
  implementation.
- **Identity key:** the Entra **Object ID (`oid`)** together with the tenant ID
  (`tid`), mapped to `Employee.entra_object_id`. Name and e-mail are display and
  contact data.
- **First sign-in:** an `Employee` already created by an administrator or by the
  directory sync is bound by Object ID. If a row has no Object ID yet, it may be
  bound by e-mail exactly once, only for the expected tenant, and the binding is
  audited. A later sign-in whose Object ID does not match the stored one is
  refused. Nobody is created automatically by signing in.
- **Authorization:** unchanged. `Employee.role_id`, group membership and
  permissions come from the database. Claims such as roles, groups, department
  or job title are ignored for authorization. The sync's "never touch existing
  roles or groups" rule stays.
- **Active status:** `Employee.is_active` and the per-request re-read stay, so
  deactivating someone ends access regardless of the Entra session.
- **Differences to handle:** Entra does not send Google's `email_verified`; the
  trust anchor becomes the tenant and Object ID. Session lifetime rules (12 hours
  idle and absolute) are kept.
- **No real tenant is touched while this is only a plan.** Validation needs a
  test tenant and an administrator.

## 5. Planned Microsoft Teams integration

**Goal:** employees open Meet Scheduling inside Teams and book, manage and view
meetings without leaving it.

- **Shape:** a Teams **personal tab** that loads the existing web application,
  with a Teams app manifest. A message extension or bot could come later and
  would call the same API.
- **Authentication in Teams:** Teams single sign-on through the Teams JavaScript
  SDK (a token for the signed-in user, validated by the server and mapped to an
  `Employee` by Object ID exactly as in section 4). A sign-in popup using the
  normal Entra flow is the fallback. The choice depends on tenant policy and is
  not made yet.
- **Reuse:** the tab is the same pages and route handlers. The only new server
  code is a way to accept a validated Entra token (a bearer token, or an
  exchange for a session) that resolves to the same `Organizer` object the
  session path returns today (`getCurrentOrganizer`). Services receive an
  employee and role as they do now and do not know about Teams.
- **Needed in the web application first (see section 8):** permission to be
  framed by Teams, a session mechanism that works inside the Teams frame,
  responsive layouts for narrow panes and mobile, and a review of the origin
  check in `guardMutation`.
- **Unchanged:** booking policies, group limits, priority, room rules, audit
  logging and notifications.

## 6. Planned Microsoft Graph integration

Graph use is already partly implemented (online meetings, directory sync). The
rest is a list of candidates, **none validated against a real tenant**.

| Capability | Permission type | Status | Considerations |
|---|---|---|---|
| Create Teams online meetings | Application, `Calendars.ReadWrite` on one organizer mailbox | Implemented, not validated in a tenant | Tenant-wide by default; restrict with an application access policy. See `DEPLOYMENT.md` 9a. |
| Directory sync of employees | Application, `User.Read.All` (and group scopes only if group sync is used) | Implemented, not validated in a tenant | Admin consent. Only identity data; no authorization derived from it. |
| Outlook calendar events for attendees | Delegated (user consent) or application | Planned | Decide between invitations by e-mail/ICS (today) and writing to calendars. Application scope is broad. |
| Send mail through Graph | Application `Mail.Send` | Possible replacement for SMTP | Needs a restricted mailbox policy. |
| Free/busy and availability | Delegated `Calendars.Read` or similar | Candidate | Privacy review first. |
| Profile data (photo, department) | Delegated `User.Read` | Candidate | Display only. |

Rules for all of them:

- Do not assume a permission is granted. Each needs tenant policy review and
  administrator consent, and a feature stays off until its configuration is
  complete (as the Teams meeting option is today).
- Tokens stay on the server. Prefer certificates or Key Vault references to
  client secrets. Do not store delegated refresh tokens without encryption and a
  retention decision.
- Every Graph call is retried with backoff and never sits inside a booking
  transaction (the pattern in `online-meeting.service.ts`).

## 7. Local POC independence

- Local sign-in (Google) and the mocked-auth test harness stay the default.
- Entra, Teams and Key Vault are enabled only by configuration. A developer with
  Docker, a Google client and `.env` can run, test and demo everything that runs
  today.
- A hosted database is a separate environment from local; running a development
  server against it is a deliberate choice and turns the background worker off
  (`REMINDER_CRON_ENABLED=false`) so it cannot send real e-mail.

## 8. Changes required before any production deployment

Compatibility is not readiness. These are the known gaps, each a decision or a
piece of work, in rough order:

1. **Enterprise sign-in mapping.** Sign-in matches on e-mail today
   (`authorizeSignIn`, `resolveOrganizerByEmail`). It must match on Object ID and
   tenant as in section 4, with audited first binding and tests.
2. **Embedding in Teams.** The headers forbid framing
   (`frame-ancestors 'none'`, `X-Frame-Options: DENY` in `next.config.ts`). They
   must allow only Teams hosts, scoped to the routes involved.
3. **Session in a frame.** Session cookies are `SameSite=Lax`, which a cross-site
   frame does not receive. Options: `SameSite=None; Secure` (and partitioned
   cookies), or a token-based session for the Teams surface. Re-check CSRF
   protection for whichever is chosen.
4. **Scheduler and rate limits are per process.** The reminder and worker jobs
   run in the server process and rate limits are in memory. Scaling out needs a
   single scheduler owner and a shared rate-limit store.
5. **Database connections.** One `pg` pool configured only by connection URL.
   Pool sizing against the managed server's connection limit, TLS verification
   and, if wanted, Entra token-based database authentication (the code uses a
   password in the URL today) must be settled.
6. **Secrets and rotation.** Move every secret to Key Vault, document rotation,
   and verify nothing secret is logged. Rotate any credential that has been used
   in development or testing.
7. **Observability.** Structured logs, Application Insights, alerts for failed
   deliveries and background jobs, and a health endpoint.
8. **Deployment and operations.** A deploy stage, environment separation,
   backup and restore tested, a migration and rollback runbook, and capacity
   limits for the database.
9. **Tenant validation not yet done.** Online meetings, directory sync and any
   new Graph feature must be tried in a real tenant with the administrator's
   consent policy before they are relied on.
10. **Security and privacy review.** Penetration test or review, retention of
    audit and personal data, accessibility check, and load testing with
    realistic concurrency.
11. **Outstanding POC items** listed in `DEPLOYMENT.md` sections 10 and 11,
    including the open owner decisions.
12. **Teams distribution.** App manifest, tenant app-policy approval and a test
    group before general release.

## 9. Open questions for the organization

- Is the application single-tenant, and which tenant? Is the Teams app to be
  published only inside it?
- Which Graph permissions will the administrators consent to, and is an
  application access policy available to scope mailbox access?
- Teams SSO or a sign-in popup: what do the tenant's conditional access and
  third-party cookie policies allow?
- Hosting: App Service or containers, network isolation, and who owns the
  scheduler?
- Which identities are administrators, and who assigns the Admin role (it is
  never derived from Entra)?
