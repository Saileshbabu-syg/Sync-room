import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  employeeSyncRuns,
  entraGroupMappings,
  entraSyncSettings,
  groupAuditLogs,
  groups,
  roles,
} from "@/db/schema";
import { dbErrorCode, PG_UNIQUE_VIOLATION } from "@/lib/api";
import { DEFAULT_GROUP_NAME, DEFAULT_ROLE_NAME } from "@/lib/constants";

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
//  * People missing from Entra are not deleted: bookings and history refer to
//    them. They are only counted.
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

export type EntraGroup = { id: string; name: string };

// Security groups of the directory, for the group mapping picker.
export async function fetchEntraGroups(
  env: Env = process.env,
  doFetch: Fetch = fetch
): Promise<EntraGroup[]> {
  const raw = await graphList<{ id?: unknown; displayName?: unknown }>(
    `https://${GRAPH_HOST}/v1.0/groups?$select=id,displayName&$filter=securityEnabled eq true&$top=999`,
    env,
    doFetch,
    "Reading the directory groups failed. The app needs the Group.Read.All application permission"
  );

  return raw
    .filter((g) => typeof g.id === "string" && UUID.test(g.id))
    .map((g) => ({
      id: (g.id as string).toLowerCase(),
      name: typeof g.displayName === "string" ? g.displayName : "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Object ids of the users directly in one Entra group.
async function fetchEntraGroupMembers(
  groupId: string,
  env: Env,
  doFetch: Fetch
): Promise<string[]> {
  const raw = await graphList<{ id?: unknown }>(
    `https://${GRAPH_HOST}/v1.0/groups/${encodeURIComponent(groupId)}/members?$select=id&$top=999`,
    env,
    doFetch,
    "Reading the group members failed. The app needs the GroupMember.Read.All application permission"
  );

  return raw
    .map((m) => (typeof m.id === "string" ? m.id.toLowerCase() : ""))
    .filter((id) => UUID.test(id));
}

export type SyncSummary = {
  runId: number;
  fetched: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  // People placed in an app group from their Entra security group (first sync only).
  mappedToGroup: number;
  assignedToDefault: number;
  notInDirectory: number;
};

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
    firstTime: [] as string[],
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
        counts.firstTime.push(user.objectId);
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
      const changed =
        linking ||
        existing.name !== user.name ||
        (emailFree && existing.email.toLowerCase() !== user.email);

      if (!changed) continue;

      await tx
        .update(employee)
        .set({
          entra_object_id: user.objectId,
          employee_name: user.name,
          ...(emailFree ? { email: user.email } : {}),
          updated_at: new Date(),
        })
        .where(eq(employee.employee_id, existing.id));

      if (linking) {
        counts.linked += 1;
        counts.firstTime.push(user.objectId);
      } else counts.updated += 1;
    }
  });

  return counts;
}

// Puts everyone who has no active group into the default group. Existing
// assignments are never changed. Returns how many people were placed.
async function assignDefaultGroup(actorEmployeeId: number | null) {
  const [group] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.name, DEFAULT_GROUP_NAME), eq(groups.isActive, true)));

  if (!group) return 0;

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

// Puts people met for the first time into the app group mapped from their Entra
// security group. Only people with NO active group are touched, so existing
// assignments are never changed. If someone is in several mapped Entra groups
// they get the app group with the highest priority (lowest number).
async function applyGroupMappings(
  firstTime: string[],
  actorEmployeeId: number | null,
  env: Env,
  doFetch: Fetch,
  provided?: Record<string, string[]>
) {
  if (firstTime.length === 0) return 0;

  const mappings = await db
    .select({
      entraGroupId: entraGroupMappings.entraGroupId,
      groupId: entraGroupMappings.groupId,
      priority: groups.priority,
    })
    .from(entraGroupMappings)
    .innerJoin(groups, eq(groups.id, entraGroupMappings.groupId))
    .where(eq(groups.isActive, true));

  if (mappings.length === 0) return 0;

  const wanted = new Map<string, { groupId: number; priority: number }>();

  for (const mapping of mappings) {
    const members =
      provided?.[mapping.entraGroupId.toLowerCase()] ??
      (await fetchEntraGroupMembers(mapping.entraGroupId, env, doFetch));

    for (const id of members) {
      const objectId = id.toLowerCase();
      const best = wanted.get(objectId);

      if (
        !best ||
        mapping.priority < best.priority ||
        (mapping.priority === best.priority && mapping.groupId < best.groupId)
      ) {
        wanted.set(objectId, { groupId: mapping.groupId, priority: mapping.priority });
      }
    }
  }

  const people = await db
    .select({ id: employee.employee_id, entraId: employee.entra_object_id })
    .from(employee)
    .where(inArray(employee.entra_object_id, firstTime));

  let placed = 0;

  for (const person of people) {
    const target = person.entraId ? wanted.get(person.entraId.toLowerCase()) : undefined;

    if (!target) continue;

    const result = await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO user_groups (employee_id, group_id, assigned_by)
        SELECT ${person.id}::int, ${target.groupId}::int, ${actorEmployeeId}::int
        WHERE NOT EXISTS (
          SELECT 1 FROM user_groups u
          WHERE u.employee_id = ${person.id}::int AND u.effective_until IS NULL
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `);

      if (inserted.rows.length === 0) return false;

      await tx.insert(groupAuditLogs).values({
        actorEmployeeId,
        action: "EMPLOYEE_ASSIGNED",
        groupId: target.groupId,
        targetEmployeeId: person.id,
        details: { source: "entra-group-mapping", toGroupId: target.groupId },
      });

      return true;
    });

    if (result) placed += 1;
  }

  return placed;
}

export async function syncEmployees({
  actorEmployeeId,
  users: provided,
  groupMembers,
  env = process.env,
  doFetch = fetch,
}: {
  actorEmployeeId: number | null;
  // Test hook: skip the directory call.
  users?: GraphUser[];
  // Test hook: Entra group id -> member object ids, instead of asking Graph.
  groupMembers?: Record<string, string[]>;
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
  const firstTime: string[] = [];

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
      firstTime.push(...counts.firstTime);

      // Visible to the screen while the sync is still running.
      await db
        .update(employeeSyncRuns)
        .set({ ...totals })
        .where(eq(employeeSyncRuns.id, runId));
    }

    // Before the default group, so a mapped person is not already "taken".
    const mappedToGroup = await applyGroupMappings(
      firstTime,
      actorEmployeeId,
      env,
      doFetch,
      groupMembers
    );

    const assignedToDefault = await assignDefaultGroup(actorEmployeeId);

    const [{ missing }] = await db
      .select({ missing: sql<number>`count(*)::int` })
      .from(employee)
      .where(
        users.length === 0
          ? sql`true`
          : sql`${employee.entra_object_id} is not null and ${employee.entra_object_id} <> all(${`{${users.map((u) => u.objectId).join(",")}}`}::uuid[])`
      );

    await db
      .update(employeeSyncRuns)
      .set({ status: "SUCCESS", finishedAt: new Date(), ...totals })
      .where(eq(employeeSyncRuns.id, runId));

    return {
      runId,
      fetched: raw.length,
      ...totals,
      mappedToGroup,
      assignedToDefault,
      notInDirectory: users.length === 0 ? 0 : missing,
    };
  } catch (error) {
    const message =
      error instanceof SyncError
        ? error.message
        : "The sync failed. Nothing was removed; run it again.";

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
