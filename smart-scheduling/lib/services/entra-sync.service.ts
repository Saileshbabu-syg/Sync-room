import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  employeeSyncRuns,
  entraSyncSettings,
  groupAuditLogs,
  groups,
  roles,
} from "@/db/schema";
import { dbErrorCode, PG_UNIQUE_VIOLATION } from "@/lib/api";
import { DEFAULT_ROLE_NAME } from "@/lib/constants";

import { resolveDefaultGroupId } from "./entra-settings.service";

// Synchronises the Employee table with Microsoft Entra ID.
//
//  * The Entra object id is the identity: an employee found by object id is
//    updated, never duplicated, even if their e-mail changes.
//  * A person already in the application with the same e-mail (added by hand, or
//    who signed up before sync existed) is LINKED to their object id instead of
//    being created twice.
//  * Existing group assignments and roles are never touched. Anyone left with no
//    active group at the end (new people included) is placed in the default
//    "Employee" group.
//  * People missing from Entra (or disabled there) are never deleted: bookings
//    and history refer to them. After a COMPLETE, successful read of the
//    directory, those linked to a directory account are DEACTIVATED (they can no
//    longer sign in or organize), unless that would exceed the safety threshold
//    (ENTRA_SYNC_MAX_DEACTIVATIONS / ENTRA_SYNC_MAX_DEACTIVATION_PERCENT), in
//    which case nobody is deactivated and the run says why. People added by hand
//    and never matched to the directory are left alone. Someone who comes back
//    to the directory is reactivated.
//  * One sync runs at a time (a partial unique index on the run table); every
//    attempt leaves a row so the screen can show progress and the last result.
//
// The directory is read with the app's own credentials (client-credentials flow,
// application permission User.Read.All) - see DEPLOYMENT.md.

export type DirectoryUser = {
  objectId: string;
  name: string;
  email: string;
};

export class SyncError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "SyncError";
    this.status = status;
  }
}

const GRAPH_HOST = "graph.microsoft.com";
const GRAPH_USERS =
  `https://${GRAPH_HOST}/v1.0/users?$select=id,displayName,mail,userPrincipalName,accountEnabled&$top=999`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHUNK = 200;
const STALE_RUN_MINUTES = 15;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 200;
// Defaults of the deactivation safety threshold: a run that would deactivate
// more than this many people, or more than this share of the active people
// linked to the directory, deactivates nobody.
const DEFAULT_MAX_DEACTIVATIONS = 25;
const DEFAULT_MAX_DEACTIVATION_PERCENT = 10;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export function entraConfigProblem(env: Env = process.env) {
  const missing = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"].filter(
    (key) => !env[key]
  );

  return missing.length > 0
    ? `Entra ID sync is not configured. Set ${missing.join(", ")}.`
    : null;
}

type GraphUser = {
  id?: unknown;
  displayName?: unknown;
  mail?: unknown;
  userPrincipalName?: unknown;
  accountEnabled?: unknown;
};

// Turns Graph's answer into clean users. Disabled accounts, accounts without a
// usable e-mail, malformed ids and duplicates are dropped (and counted).
export function normalizeDirectoryUsers(raw: GraphUser[]) {
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  const users: DirectoryUser[] = [];
  let skipped = 0;

  for (const entry of raw) {
    const objectId = typeof entry.id === "string" ? entry.id.toLowerCase() : "";
    const mail =
      typeof entry.mail === "string" && entry.mail
        ? entry.mail
        : typeof entry.userPrincipalName === "string"
          ? entry.userPrincipalName
          : "";
    const email = mail.trim().toLowerCase();
    const name = (
      typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : email.split("@")[0]
    ).slice(0, 100);

    if (
      !UUID.test(objectId) ||
      !EMAIL.test(email) ||
      email.length > 150 ||
      entry.accountEnabled === false ||
      seenIds.has(objectId) ||
      seenEmails.has(email)
    ) {
      skipped += 1;
      continue;
    }

    seenIds.add(objectId);
    seenEmails.add(email);
    users.push({ objectId, name, email });
  }

  return { users, skipped };
}

async function graphToken(env: Env, doFetch: Fetch) {
  const response = await doFetch(
    `https://login.microsoftonline.com/${encodeURIComponent(env.ENTRA_TENANT_ID!)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.ENTRA_CLIENT_ID!,
        client_secret: env.ENTRA_CLIENT_SECRET!,
        scope: `https://${GRAPH_HOST}/.default`,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    // Never echo the response body: it can name the tenant and client.
    throw new SyncError(
      `Microsoft sign-in for the sync failed (HTTP ${response.status}). Check the Entra ID credentials.`,
      502
    );
  }

  const body = (await response.json()) as { access_token?: string };

  if (!body.access_token) {
    throw new SyncError("Microsoft did not return an access token.", 502);
  }

  return body.access_token;
}

// Reads a Graph collection, following paging links. A link is only followed
// if it points back at Graph.
async function graphList<T>(
  firstUrl: string,
  env: Env,
  doFetch: Fetch,
  failure: string
): Promise<T[]> {
  const problem = entraConfigProblem(env);

  if (problem) throw new SyncError(problem, 503);

  const token = await graphToken(env, doFetch);
  const all: T[] = [];
  let url: string | undefined = firstUrl;

  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGES) {
      throw new SyncError("The directory returned too many pages.", 502);
    }

    if (new URL(url).host !== GRAPH_HOST) {
      throw new SyncError("Microsoft returned an unexpected paging link.", 502);
    }

    const response = await doFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new SyncError(`${failure} (HTTP ${response.status}).`, 502);
    }

    const body = (await response.json()) as {
      value?: T[];
      "@odata.nextLink"?: string;
    };

    all.push(...(body.value ?? []));
    url = body["@odata.nextLink"];
  }

  return all;
}

// All users of the directory.
export function fetchEntraUsers(
  env: Env = process.env,
  doFetch: Fetch = fetch
): Promise<GraphUser[]> {
  return graphList<GraphUser>(
    GRAPH_USERS,
    env,
    doFetch,
    "Reading the directory failed. The app needs the User.Read.All application permission"
  );
}

export type SyncSummary = {
  runId: number;
  fetched: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  assignedToDefault: number;
  notInDirectory: number;
  deactivated: number;
  // Set when people missing from the directory were deliberately not
  // deactivated (empty directory, over the safety threshold).
  deactivationNote: string | null;
};

function readThreshold(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") return fallback;

  const n = Number(value);

  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function deactivationThreshold(env: Env = process.env) {
  return {
    maxCount: readThreshold(
      env.ENTRA_SYNC_MAX_DEACTIVATIONS,
      DEFAULT_MAX_DEACTIVATIONS
    ),
    maxPercent: readThreshold(
      env.ENTRA_SYNC_MAX_DEACTIVATION_PERCENT,
      DEFAULT_MAX_DEACTIVATION_PERCENT
    ),
  };
}

// Object ids of every ENABLED account the directory returned, including ones
// skipped for an unusable e-mail: those people still exist and must not be
// deactivated. Disabled accounts are left out, so their employees are.
function presentObjectIds(raw: GraphUser[]) {
  const ids = new Set<string>();

  for (const entry of raw) {
    const id = typeof entry.id === "string" ? entry.id.toLowerCase() : "";

    if (UUID.test(id) && entry.accountEnabled !== false) ids.add(id);
  }

  return ids;
}

// Deactivates active employees linked to a directory account that the (complete)
// directory read no longer contains, unless that is suspiciously many. Only
// called after every other step of the run succeeded.
async function deactivateMissing(
  present: Set<string>,
  env: Env,
  actorEmployeeId: number | null
): Promise<{ deactivated: number; note: string | null }> {
  if (present.size === 0) {
    return {
      deactivated: 0,
      note: "The directory returned no active accounts, so nobody was deactivated.",
    };
  }

  const linked = await db
    .select({ id: employee.employee_id, entraId: employee.entra_object_id })
    .from(employee)
    .where(
      and(eq(employee.is_active, true), sql`${employee.entra_object_id} is not null`)
    );

  const missing = linked.filter((e) => !present.has(e.entraId!.toLowerCase()));

  if (missing.length === 0) return { deactivated: 0, note: null };

  const { maxCount, maxPercent } = deactivationThreshold(env);
  const percent = (missing.length * 100) / linked.length;

  if (missing.length > maxCount || percent > maxPercent) {
    return {
      deactivated: 0,
      note:
        `${missing.length} employee(s) missing from the directory (${percent.toFixed(1)}% of linked active employees) ` +
        `exceeds the safety threshold (${maxCount} / ${maxPercent}%), so nobody was deactivated. ` +
        "Check the directory, or raise ENTRA_SYNC_MAX_DEACTIVATIONS / ENTRA_SYNC_MAX_DEACTIVATION_PERCENT.",
    };
  }

  const ids = missing.map((m) => m.id);

  await db.transaction(async (tx) => {
    await tx
      .update(employee)
      .set({ is_active: false, deactivated_at: new Date(), updated_at: new Date() })
      .where(and(inArray(employee.employee_id, ids), eq(employee.is_active, true)));

    await tx.insert(groupAuditLogs).values({
      actorEmployeeId,
      action: "EMPLOYEES_DEACTIVATED",
      details: {
        source: "entra-sync",
        count: ids.length,
        employeeIds: ids.slice(0, 500),
      },
    });
  });

  return { deactivated: ids.length, note: null };
}

async function closeStaleRuns() {
  await db
    .update(employeeSyncRuns)
    .set({
      status: "FAILED",
      finishedAt: new Date(),
      error: "The sync did not finish (the server stopped or timed out).",
    })
    .where(
      and(
        eq(employeeSyncRuns.status, "RUNNING"),
        lt(
          employeeSyncRuns.startedAt,
          sql`now() - make_interval(mins => ${STALE_RUN_MINUTES})`
        )
      )
    );
}

// Applies one batch of directory users. Returns what changed.
async function applyChunk(users: DirectoryUser[], roleId: number) {
  const counts = {
    created: 0,
    updated: 0,
    linked: 0,
    skipped: 0,
    // Object ids of people met for the first time (created or linked).
  };

  await db.transaction(async (tx) => {
    const ids = users.map((u) => u.objectId);
    const emails = users.map((u) => u.email);

    const known = await tx
      .select({
        id: employee.employee_id,
        email: employee.email,
        entraId: employee.entra_object_id,
        name: employee.employee_name,
        isActive: employee.is_active,
      })
      .from(employee)
      .where(
        sql`${inArray(employee.entra_object_id, ids)} or lower(${employee.email}) in (${sql.join(
          emails.map((e) => sql`${e}`),
          sql`, `
        )})`
      );

    const byEntra = new Map(
      known.filter((k) => k.entraId).map((k) => [k.entraId!.toLowerCase(), k])
    );
    const byEmail = new Map(known.map((k) => [k.email.toLowerCase(), k]));

    for (const user of users) {
      const existing = byEntra.get(user.objectId) ?? byEmail.get(user.email);

      if (!existing) {
        await tx.insert(employee).values({
          role_id: roleId,
          employee_name: user.name,
          email: user.email,
          entra_object_id: user.objectId,
        });
        counts.created += 1;
        continue;
      }

      // The e-mail is the login key: only move it if nobody else holds it.
      const emailOwner = byEmail.get(user.email);
      const emailFree = !emailOwner || emailOwner.id === existing.id;

      if (existing.entraId && existing.entraId.toLowerCase() !== user.objectId) {
        // That e-mail already belongs to a different directory account.
        counts.skipped += 1;
        continue;
      }

      const linking = !existing.entraId;
      // Back in the directory (enabled): a deactivated person is active again.
      const reactivating = !existing.isActive;
      const changed =
        linking ||
        reactivating ||
        existing.name !== user.name ||
        (emailFree && existing.email.toLowerCase() !== user.email);

      if (!changed) continue;

      await tx
        .update(employee)
        .set({
          entra_object_id: user.objectId,
          employee_name: user.name,
          ...(emailFree ? { email: user.email } : {}),
          ...(reactivating ? { is_active: true, deactivated_at: null } : {}),
          updated_at: new Date(),
        })
        .where(eq(employee.employee_id, existing.id));

      if (linking) {
        counts.linked += 1;
      } else counts.updated += 1;
    }
  });

  return counts;
}

// Puts everyone who has no active group into the default group chosen in the
// sync settings (the Employee group unless an admin picked another). Existing
// assignments are never changed. Returns how many people were placed.
async function assignDefaultGroup(actorEmployeeId: number | null) {
  const groupId = await resolveDefaultGroupId();

  if (groupId === null) return 0;

  const group = { id: groupId };

  return db.transaction(async (tx) => {
    // The partial unique index (one open row per employee) makes this safe
    // against a concurrent admin change: a clash is skipped, not an error.
    const result = await tx.execute(sql`
      INSERT INTO user_groups (employee_id, group_id, assigned_by)
      SELECT e.employee_id, ${group.id}::int, ${actorEmployeeId}::int
      FROM "Employee" e
      WHERE NOT EXISTS (
        SELECT 1 FROM user_groups u
        WHERE u.employee_id = e.employee_id AND u.effective_until IS NULL
      )
      ON CONFLICT DO NOTHING
      RETURNING employee_id
    `);

    const placed = result.rows as { employee_id: number }[];

    if (placed.length > 0) {
      await tx.insert(groupAuditLogs).values({
        actorEmployeeId,
        action: "EMPLOYEES_DEFAULT_GROUP",
        groupId: group.id,
        details: {
          source: "entra-sync",
          count: placed.length,
          employeeIds: placed.slice(0, 500).map((p) => p.employee_id),
        },
      });
    }

    return placed.length;
  });
}

export async function syncEmployees({
  actorEmployeeId,
  users: provided,
  env = process.env,
  doFetch = fetch,
}: {
  actorEmployeeId: number | null;
  // Test hook: skip the directory call.
  users?: GraphUser[];
  env?: Env;
  doFetch?: Fetch;
}): Promise<SyncSummary> {
  if (!provided) {
    const problem = entraConfigProblem(env);

    if (problem) throw new SyncError(problem, 503);
  }

  await closeStaleRuns();

  let runId: number;

  try {
    const [run] = await db
      .insert(employeeSyncRuns)
      .values({ triggeredBy: actorEmployeeId })
      .returning({ id: employeeSyncRuns.id });

    runId = run.id;
  } catch (error) {
    if (dbErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new SyncError("A sync is already running. Try again shortly.", 409);
    }

    throw error;
  }

  const totals = { created: 0, updated: 0, linked: 0, skipped: 0 };

  try {
    const [role] = await db
      .select({ id: roles.roleId })
      .from(roles)
      .where(eq(roles.roleName, DEFAULT_ROLE_NAME));

    if (!role) {
      throw new SyncError(`The "${DEFAULT_ROLE_NAME}" role does not exist.`, 500);
    }

    const raw = provided ?? (await fetchEntraUsers(env, doFetch));
    const { users, skipped } = normalizeDirectoryUsers(raw);

    totals.skipped += skipped;

    await db
      .update(employeeSyncRuns)
      .set({ fetched: raw.length, skipped: totals.skipped })
      .where(eq(employeeSyncRuns.id, runId));

    for (let i = 0; i < users.length; i += CHUNK) {
      const counts = await applyChunk(users.slice(i, i + CHUNK), role.id);

      totals.created += counts.created;
      totals.updated += counts.updated;
      totals.linked += counts.linked;
      totals.skipped += counts.skipped;

      // Visible to the screen while the sync is still running.
      await db
        .update(employeeSyncRuns)
        .set({ ...totals })
        .where(eq(employeeSyncRuns.id, runId));
    }

    const assignedToDefault = await assignDefaultGroup(actorEmployeeId);

    const [{ missing }] = await db
      .select({ missing: sql<number>`count(*)::int` })
      .from(employee)
      .where(
        users.length === 0
          ? sql`true`
          : sql`${employee.entra_object_id} is not null and ${employee.entra_object_id} <> all(${`{${users.map((u) => u.objectId).join(",")}}`}::uuid[])`
      );

    // Last, and only now that the whole directory was read and applied: a
    // failure anywhere above skips this entirely (the catch below).
    const deactivation = await deactivateMissing(
      presentObjectIds(raw),
      env,
      actorEmployeeId
    );

    await db
      .update(employeeSyncRuns)
      .set({
        status: "SUCCESS",
        finishedAt: new Date(),
        ...totals,
        deactivated: deactivation.deactivated,
        deactivation_note: deactivation.note,
      })
      .where(eq(employeeSyncRuns.id, runId));

    console.info(
      `Entra sync ${runId}: fetched ${raw.length}, created ${totals.created}, ` +
        `updated ${totals.updated}, linked ${totals.linked}, ` +
        `deactivated ${deactivation.deactivated}, skipped ${totals.skipped}` +
        (deactivation.note ? `. ${deactivation.note}` : "")
    );

    return {
      runId,
      fetched: raw.length,
      ...totals,
      assignedToDefault,
      notInDirectory: users.length === 0 ? 0 : missing,
      deactivated: deactivation.deactivated,
      deactivationNote: deactivation.note,
    };
  } catch (error) {
    const message =
      error instanceof SyncError
        ? error.message
        : "The sync failed. Nobody was removed or deactivated; run it again.";

    if (!(error instanceof SyncError)) console.error("Entra sync failed:", error);

    await db
      .update(employeeSyncRuns)
      .set({ status: "FAILED", finishedAt: new Date(), error: message, ...totals })
      .where(eq(employeeSyncRuns.id, runId));

    throw error instanceof SyncError ? error : new SyncError(message, 500);
  }
}

export type SyncStatus = {
  configured: boolean;
  configProblem: string | null;
  running: boolean;
  last: {
    id: number;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    fetched: number;
    created: number;
    updated: number;
    linked: number;
    skipped: number;
    deactivated: number;
    deactivationNote: string | null;
    error: string | null;
  } | null;
  lastSuccessAt: string | null;
};

export async function getSyncStatus(env: Env = process.env): Promise<SyncStatus> {
  await closeStaleRuns();

  const [last] = await db
    .select()
    .from(employeeSyncRuns)
    .orderBy(desc(employeeSyncRuns.startedAt), desc(employeeSyncRuns.id))
    .limit(1);

  const [success] = await db
    .select({ at: employeeSyncRuns.finishedAt })
    .from(employeeSyncRuns)
    .where(eq(employeeSyncRuns.status, "SUCCESS"))
    .orderBy(desc(employeeSyncRuns.finishedAt))
    .limit(1);

  const problem = entraConfigProblem(env);

  return {
    configured: problem === null,
    configProblem: problem,
    running: last?.status === "RUNNING",
    last: last
      ? {
          id: last.id,
          status: last.status,
          startedAt: last.startedAt.toISOString(),
          finishedAt: last.finishedAt?.toISOString() ?? null,
          fetched: last.fetched,
          created: last.created,
          updated: last.updated,
          linked: last.linked,
          skipped: last.skipped,
          deactivated: last.deactivated,
          deactivationNote: last.deactivation_note,
          error: last.error,
        }
      : null,
    lastSuccessAt: success?.at?.toISOString() ?? null,
  };
}

// Runs a sync if automatic sync is on and the last attempt is older than the
// interval. Called from the per-minute job; safe to call on every instance (only
// one sync can be running, and a clash is simply skipped). Returns whether a sync
// was started and finished.
export async function runScheduledSync(
  now: Date = new Date(),
  env: Env = process.env
) {
  const [settings] = await db.select().from(entraSyncSettings);

  if (!settings?.autoSyncEnabled || entraConfigProblem(env)) return false;

  const [last] = await db
    .select({ startedAt: employeeSyncRuns.startedAt })
    .from(employeeSyncRuns)
    .orderBy(desc(employeeSyncRuns.startedAt))
    .limit(1);

  if (
    last &&
    now.getTime() - last.startedAt.getTime() < settings.intervalHours * 3_600_000
  ) {
    return false;
  }

  try {
    await syncEmployees({ actorEmployeeId: null, env });

    return true;
  } catch (error) {
    // Already running elsewhere is fine; anything else is recorded on the run.
    if (!(error instanceof SyncError && error.status === 409)) {
      console.error(
        "Scheduled Entra sync failed:",
        error instanceof Error ? error.message : "unknown error"
      );
    }

    return false;
  }
}
