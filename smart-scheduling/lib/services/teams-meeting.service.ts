import { APP_TIMEZONE } from "@/lib/constants";
import { slotEndDate } from "@/lib/time";

// The ONLY place that talks to Microsoft Graph for online meetings. Nothing
// else in the application builds a Graph URL or handles a Graph token.
//
// A Teams meeting is a calendar event with `isOnlineMeeting: true` created in
// ONE designated organizer mailbox (app-only, client-credentials flow). The
// event has no attendees: the application's own e-mails tell people, so
// Outlook never sends a second invitation.
//
// Credentials are deliberately separate from the Google sign-in and from the
// Entra directory sync (TEAMS_* variables, see .env.example / DEPLOYMENT.md).
//
// To move to delegated (per-user) authentication later, supply a different
// TokenProvider and event owner to createGraphTeamsProvider(); the booking
// workflow only uses the TeamsMeetingProvider interface.

export const TEAMS_PROVIDER = "MICROSOFT_TEAMS";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 15_000;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export type TeamsErrorCode =
  | "NOT_CONFIGURED"
  | "AUTH"
  | "PERMISSION"
  | "NOT_FOUND"
  | "THROTTLED"
  | "GRAPH"
  | "TIMEOUT"
  | "NO_JOIN_URL";

export class TeamsError extends Error {
  code: TeamsErrorCode;
  status: number;
  // Worth retrying later (throttling, a Microsoft outage, a timeout); false
  // for problems that only a person can fix (permissions, configuration).
  retryable: boolean;
  // What Microsoft asked us to wait (Retry-After), when it said.
  retryAfterMs?: number;

  constructor(
    message: string,
    code: TeamsErrorCode,
    status = 502,
    options: { retryable?: boolean; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "TeamsError";
    this.code = code;
    this.status = status;
    this.retryable =
      options.retryable ??
      (code === "THROTTLED" || code === "TIMEOUT" || code === "GRAPH");
    this.retryAfterMs = options.retryAfterMs;
  }
}

// Retry-After: seconds, or an HTTP date. Undefined when absent or unusable.
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now()
): number | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const at = Date.parse(trimmed);

  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// Statuses that mean "try again later": throttling and transient service
// failures. Everything else 4xx is permanent.
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Wall-clock slot of a meeting, exactly as stored (APP_TIMEZONE).
export type OnlineMeetingSlot = {
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  // The booked room, shown as the event location.
  roomName?: string;
};

export type CreatedTeamsEvent = { eventId: string; joinUrl: string };

export interface TeamsMeetingProvider {
  // `transactionId` makes a repeated create (retry, double click, crash after
  // Graph answered) return the SAME event instead of a second meeting.
  createEvent(
    slot: OnlineMeetingSlot,
    transactionId: string
  ): Promise<CreatedTeamsEvent>;
  updateEvent(eventId: string, slot: OnlineMeetingSlot): Promise<void>;
  // An event that is already gone counts as deleted (idempotent).
  deleteEvent(eventId: string): Promise<void>;
}

export type TokenProvider = () => Promise<string>;

export function teamsConfigProblems(env: Env = process.env): string[] {
  const problems: string[] = [];

  if (!env.TEAMS_TENANT_ID) problems.push("TEAMS_TENANT_ID is not set.");
  if (!env.TEAMS_CLIENT_ID) problems.push("TEAMS_CLIENT_ID is not set.");
  if (!env.TEAMS_CLIENT_SECRET) problems.push("TEAMS_CLIENT_SECRET is not set.");

  if (!env.TEAMS_ORGANIZER_EMAIL) {
    problems.push("TEAMS_ORGANIZER_EMAIL is not set.");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.TEAMS_ORGANIZER_EMAIL)) {
    problems.push("TEAMS_ORGANIZER_EMAIL is not a valid e-mail address.");
  }

  return problems;
}

export function isTeamsConfigured(env: Env = process.env) {
  return teamsConfigProblems(env).length === 0;
}

// App-only token for the Teams app registration. Cached until shortly before
// it expires. Never logs or returns the response body.
export function clientCredentialsTokenProvider(
  env: Env = process.env,
  doFetch: Fetch = fetch
): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;

  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    let response: Response;

    try {
      response = await doFetch(
        `https://login.microsoftonline.com/${encodeURIComponent(env.TEAMS_TENANT_ID!)}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.TEAMS_CLIENT_ID!,
            client_secret: env.TEAMS_CLIENT_SECRET!,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials",
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
    } catch (error) {
      throw networkError(error);
    }

    if (!response.ok) {
      // A Microsoft hiccup on the sign-in endpoint is retried; a refused
      // credential (400/401: wrong id, expired secret) needs a person.
      const transient = TRANSIENT_STATUS.has(response.status);

      throw new TeamsError(
        transient
          ? `Microsoft sign-in for Teams is temporarily unavailable (HTTP ${response.status}).`
          : `Microsoft sign-in for Teams failed (HTTP ${response.status}). Check the TEAMS_* credentials and that the client secret has not expired.`,
        "AUTH",
        response.status,
        {
          retryable: transient,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        }
      );
    }

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!body.access_token) {
      throw new TeamsError("Microsoft did not return an access token.", "AUTH");
    }

    const lifetime = Math.max(60, Number(body.expires_in) || 3600);

    cached = {
      token: body.access_token,
      expiresAt: Date.now() + (lifetime - 60) * 1000,
    };

    return cached.token;
  };
}

function networkError(error: unknown) {
  const timedOut = error instanceof Error && error.name === "TimeoutError";

  return new TeamsError(
    timedOut
      ? "Microsoft did not answer in time."
      : "Could not reach Microsoft.",
    timedOut ? "TIMEOUT" : "GRAPH"
  );
}

// Hosts of the Teams joining links Microsoft Graph returns: commercial and
// education tenants, Teams for personal accounts, and the US government
// clouds. Exact matches only: "teams.evil.example" or
// "teams.microsoft.com.evil.example" are not Teams.
export const TEAMS_JOIN_HOSTS = new Set([
  "teams.microsoft.com",
  "teams.live.com",
  "gov.teams.microsoft.us",
  "dod.teams.microsoft.us",
]);

// "2026-12-01" + "09:30" / "09:30:00" -> "2026-12-01T09:30:00"
function wallClock(date: string, time: string) {
  return `${date}T${time.length === 5 ? `${time}:00` : time.slice(0, 8)}`;
}

function eventBody(slot: OnlineMeetingSlot) {
  return {
    subject: slot.title,
    // The room (display only; the event has no attendees or resources).
    ...(slot.roomName ? { location: { displayName: slot.roomName } } : {}),
    start: {
      dateTime: wallClock(slot.meetingDate, slot.startTime),
      timeZone: APP_TIMEZONE,
    },
    end: {
      dateTime: wallClock(
        slotEndDate(slot.meetingDate, slot.startTime, slot.endTime),
        slot.endTime
      ),
      timeZone: APP_TIMEZONE,
    },
  };
}

// Only a real https Teams link is ever stored or e-mailed: https, one of the
// Teams hosts exactly, default port, no user name or password in the URL.
export function isValidJoinUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      TEAMS_JOIN_HOSTS.has(url.hostname.toLowerCase()) &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function createGraphTeamsProvider({
  organizerEmail,
  tokenProvider,
  doFetch = fetch,
}: {
  // Mailbox that owns the events (app-only: the designated organizer).
  organizerEmail: string;
  tokenProvider: TokenProvider;
  doFetch?: Fetch;
}): TeamsMeetingProvider {
  const eventsUrl = `${GRAPH_BASE}/users/${encodeURIComponent(organizerEmail)}/events`;

  async function call(
    method: string,
    url: string,
    body?: unknown
  ) {
    const token = await tokenProvider();

    let response: Response;

    try {
      response = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(error);
    }

    return response;
  }

  // Maps a failed Graph answer to a safe message. The response body is never
  // echoed: it can name the tenant and the mailbox.
  function failure(response: Response, action: string) {
    const status = response.status;

    if (status === 401) {
      return new TeamsError(
        `Microsoft rejected the Teams credentials while trying to ${action}.`,
        "AUTH",
        status
      );
    }

    if (status === 403) {
      return new TeamsError(
        `The Teams app is not permitted to ${action} in the organizer mailbox. Check the Calendars.ReadWrite consent and the Exchange access scope.`,
        "PERMISSION",
        status
      );
    }

    if (status === 404) {
      return new TeamsError(
        "The organizer mailbox or the calendar event was not found.",
        "NOT_FOUND",
        status
      );
    }

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

    if (status === 429) {
      return new TeamsError(
        "Microsoft is busy right now. Please try again in a moment.",
        "THROTTLED",
        status,
        { retryable: true, retryAfterMs }
      );
    }

    // 5xx / 408: a passing Microsoft problem; other 4xx (bad request,
    // conflict...) will not get better by waiting.
    return new TeamsError(
      `Microsoft could not ${action} (HTTP ${status}).`,
      "GRAPH",
      status,
      { retryable: TRANSIENT_STATUS.has(status), retryAfterMs }
    );
  }

  async function removeEvent(eventId: string) {
    const response = await call(
      "DELETE",
      `${eventsUrl}/${encodeURIComponent(eventId)}`
    );

    // Already deleted (404/410) is the state we want.
    if (response.ok || response.status === 404 || response.status === 410) {
      return;
    }

    throw failure(response, "cancel the Teams meeting");
  }

  return {
    async createEvent(slot, transactionId) {
      const response = await call("POST", eventsUrl, {
        ...eventBody(slot),
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        // Organizer only: attendees are told by the application's e-mails.
        transactionId,
      });

      if (!response.ok) throw failure(response, "create the Teams meeting");

      const event = (await response.json().catch(() => null)) as {
        id?: string;
        onlineMeeting?: { joinUrl?: string } | null;
      } | null;

      if (!event?.id) {
        throw new TeamsError("Microsoft did not return an event id.", "GRAPH");
      }

      const joinUrl = event.onlineMeeting?.joinUrl;

      if (!isValidJoinUrl(joinUrl)) {
        // The event exists but has no usable link: remove it so it does not
        // linger, and report the failure (best effort; the same
        // transactionId would return it again on a retry anyway).
        await removeEvent(event.id).catch(() => undefined);

        throw new TeamsError(
          "Microsoft created the event but returned no Teams joining link.",
          "NO_JOIN_URL"
        );
      }

      return { eventId: event.id, joinUrl };
    },

    async updateEvent(eventId, slot) {
      const response = await call(
        "PATCH",
        `${eventsUrl}/${encodeURIComponent(eventId)}`,
        eventBody(slot)
      );

      if (!response.ok) throw failure(response, "update the Teams meeting");
    },

    deleteEvent: removeEvent,
  };
}

let override: TeamsMeetingProvider | null = null;
let cached: { key: string; provider: TeamsMeetingProvider } | null = null;

// Test hook: use a fake provider (or null to go back to Graph).
export function setTeamsProvider(next: TeamsMeetingProvider | null) {
  override = next;
}

// Whether the toggle can be offered at all.
export function isOnlineMeetingAvailable() {
  return override !== null || isTeamsConfigured();
}

export function getTeamsProvider(): TeamsMeetingProvider {
  if (override) return override;

  const problems = teamsConfigProblems();

  if (problems.length > 0) {
    throw new TeamsError(
      "Online Teams meetings are not configured on this server.",
      "NOT_CONFIGURED",
      503
    );
  }

  const key = [
    process.env.TEAMS_TENANT_ID,
    process.env.TEAMS_CLIENT_ID,
    process.env.TEAMS_ORGANIZER_EMAIL,
  ].join("|");

  if (!cached || cached.key !== key) {
    cached = {
      key,
      provider: createGraphTeamsProvider({
        organizerEmail: process.env.TEAMS_ORGANIZER_EMAIL!,
        tokenProvider: clientCredentialsTokenProvider(),
      }),
    };
  }

  return cached.provider;
}

export type TeamsHealthCheck = { ok: boolean | null; message: string };

export type TeamsHealth = {
  // Whether every TEAMS_* setting is present and well formed.
  configuration: TeamsHealthCheck & { problems: string[] };
  // Whether Microsoft issues an app-only token with these credentials.
  authentication: TeamsHealthCheck;
  // Whether the token carries the Calendars.ReadWrite application role.
  permissions: TeamsHealthCheck & { roles: string[] };
  // Whether the organizer mailbox's calendar can be reached with it.
  mailbox: TeamsHealthCheck & { organizer: string | null };
};

const REQUIRED_ROLE = "Calendars.ReadWrite";

// The `roles` claim of an app-only token (names of granted application
// permissions). Read locally; the token itself is never returned or logged.
function tokenRoles(token: string): string[] {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const roles = (JSON.parse(json) as { roles?: unknown }).roles;

    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

// Read-only health check of the Teams integration: configuration, sign-in,
// granted permission and access to the organizer mailbox. Creates nothing.
// Each part is reported separately; a part that could not be checked because
// an earlier one failed is `ok: null`. The client secret's expiry date cannot
// be read with the app's own credentials, so it is not reported: watch it in
// the Entra portal (see DEPLOYMENT.md).
export async function checkTeamsHealth(
  env: Env = process.env,
  doFetch: Fetch = fetch
): Promise<TeamsHealth> {
  const problems = teamsConfigProblems(env);
  const organizer = env.TEAMS_ORGANIZER_EMAIL ?? null;
  const skipped = (why: string): TeamsHealthCheck => ({ ok: null, message: why });

  const health: TeamsHealth = {
    configuration: {
      ok: problems.length === 0,
      message: problems.length === 0 ? "All Teams settings are present." : "Teams is not configured.",
      problems,
    },
    authentication: skipped("Not checked: the configuration is incomplete."),
    permissions: { ...skipped("Not checked: the configuration is incomplete."), roles: [] },
    mailbox: { ...skipped("Not checked: the configuration is incomplete."), organizer },
  };

  if (problems.length > 0) return health;

  let token: string;

  try {
    token = await clientCredentialsTokenProvider(env, doFetch)();
    health.authentication = { ok: true, message: "Microsoft issued an app-only token." };
  } catch (error) {
    const message = error instanceof TeamsError ? error.message : "Could not reach Microsoft.";

    health.authentication = { ok: false, message };
    health.permissions = { ...skipped("Not checked: sign-in failed."), roles: [] };
    health.mailbox = { ...skipped("Not checked: sign-in failed."), organizer };

    return health;
  }

  const roles = tokenRoles(token);

  health.permissions = roles.includes(REQUIRED_ROLE)
    ? { ok: true, message: `${REQUIRED_ROLE} (application) is granted.`, roles }
    : {
        ok: false,
        message: `The app does not have the ${REQUIRED_ROLE} application permission (with admin consent).`,
        roles,
      };

  try {
    const response = await doFetch(
      `${GRAPH_BASE}/users/${encodeURIComponent(organizer!)}/calendar?$select=id`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    health.mailbox = response.ok
      ? { ok: true, message: "The organizer mailbox's calendar is reachable.", organizer }
      : {
          ok: false,
          message:
            response.status === 403
              ? "The app may not use the organizer mailbox. Check the Exchange application access policy."
              : response.status === 404
                ? "The organizer mailbox was not found."
                : `Microsoft could not open the organizer mailbox (HTTP ${response.status}).`,
          organizer,
        };
  } catch (error) {
    health.mailbox = { ok: false, message: networkError(error).message, organizer };
  }

  return health;
}
