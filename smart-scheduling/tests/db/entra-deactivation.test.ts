import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { employee, employeeSyncRuns, groupAuditLogs } from "@/db/schema";
import {
  deactivationThreshold,
  getSyncStatus,
  SyncError,
  syncEmployees,
} from "@/lib/services/entra-sync.service";
import { resolveOrganizerByEmail } from "@/lib/services/identity.service";

import { seedFixtures, type Fixtures } from "../helpers/fixtures";

// S-03: the Entra sync deactivates people who left the directory, but only
// after a complete, successful read and within the safety threshold.

let f: Fixtures;

before(async () => {
  f = await seedFixtures();
});

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const entry = (n: number, email: string, accountEnabled = true) => ({
  id: ID(n),
  displayName: `User ${n}`,
  mail: email,
  accountEnabled,
});

// Bob, Carol and Manager Mona are in the directory as 1, 2, 3; Alice (admin)
// and Dave were added by hand and are never matched.
const everyone = () => [
  entry(1, f.users.bob.email),
  entry(2, f.users.carol.email),
  entry(3, f.users.manager.email),
];

const PERMISSIVE = {
  ENTRA_SYNC_MAX_DEACTIVATIONS: "100",
  ENTRA_SYNC_MAX_DEACTIVATION_PERCENT: "100",
};

const run = (users: ReturnType<typeof entry>[], env: Record<string, string> = PERMISSIVE) =>
  syncEmployees({ actorEmployeeId: f.users.admin.employeeId, users, env });

const isActive = async (employeeId: number) =>
  (await db.select({ a: employee.is_active }).from(employee).where(eq(employee.employee_id, employeeId)))[0].a;

beforeEach(async () => {
  // group_audit_logs is append-only (DELETE is refused); TRUNCATE is allowed.
  await db.execute(sql`TRUNCATE employee_sync_runs, group_audit_logs RESTART IDENTITY`);
  await db.update(employee).set({ entra_object_id: null, is_active: true, deactivated_at: null });
  await run(everyone());
});

describe("Entra sync deactivation (S-03)", () => {
  it("a complete sync deactivates someone who left the directory, and records it", async () => {
    const summary = await run([entry(2, f.users.carol.email), entry(3, f.users.manager.email)]);

    assert.equal(summary.deactivated, 1);
    assert.equal(summary.deactivationNote, null);
    assert.equal(await isActive(f.users.bob.employeeId), false);
    assert.equal(await isActive(f.users.carol.employeeId), true);

    // The row stays (bookings refer to it); access is gone.
    assert.equal(await resolveOrganizerByEmail(f.users.bob.email), null);

    const [audit] = await db.select().from(groupAuditLogs).where(eq(groupAuditLogs.action, "EMPLOYEES_DEACTIVATED"));
    assert.deepEqual((audit.details as { employeeIds: number[] }).employeeIds, [f.users.bob.employeeId]);

    const status = await getSyncStatus({});
    assert.equal(status.last?.deactivated, 1);
  });

  it("an account disabled in the directory is deactivated too", async () => {
    const summary = await run([
      entry(1, f.users.bob.email, false),
      entry(2, f.users.carol.email),
      entry(3, f.users.manager.email),
    ]);

    assert.equal(summary.deactivated, 1);
    assert.equal(await isActive(f.users.bob.employeeId), false);
  });

  it("someone who comes back is reactivated", async () => {
    await run([entry(2, f.users.carol.email), entry(3, f.users.manager.email)]);
    assert.equal(await isActive(f.users.bob.employeeId), false);

    await run(everyone());

    assert.equal(await isActive(f.users.bob.employeeId), true);
    assert.ok(await resolveOrganizerByEmail(f.users.bob.email));
  });

  it("people added by hand and never matched to the directory are left alone", async () => {
    await run(everyone());

    assert.equal(await isActive(f.users.admin.employeeId), true);
    assert.equal(await isActive(f.users.dave.employeeId), true);
  });

  it("people the directory lists with an unusable e-mail are not treated as gone", async () => {
    const summary = await run([
      { ...entry(1, "not-an-email"), mail: "not-an-email" },
      entry(2, f.users.carol.email),
      entry(3, f.users.manager.email),
    ]);

    assert.equal(summary.deactivated, 0);
    assert.equal(await isActive(f.users.bob.employeeId), true);
  });

  it("an empty directory never deactivates anyone", async () => {
    const summary = await run([]);

    assert.equal(summary.deactivated, 0);
    assert.match(summary.deactivationNote ?? "", /no active accounts/);
    assert.ok((await db.select().from(employee)).every((e) => e.is_active));
  });

  it("the safety threshold blocks a mass deactivation", async () => {
    // 2 of 3 linked people missing: over a 50% threshold.
    const summary = await run([entry(3, f.users.manager.email)], {
      ENTRA_SYNC_MAX_DEACTIVATIONS: "100",
      ENTRA_SYNC_MAX_DEACTIVATION_PERCENT: "50",
    });

    assert.equal(summary.deactivated, 0);
    assert.match(summary.deactivationNote ?? "", /safety threshold/);
    assert.equal(await isActive(f.users.bob.employeeId), true);
    assert.equal(await isActive(f.users.carol.employeeId), true);

    const [row] = await db.select().from(employeeSyncRuns).orderBy(sql`id desc`).limit(1);
    assert.equal(row.status, "SUCCESS");
    assert.match(row.deactivation_note ?? "", /safety threshold/);
  });

  it("the count threshold applies as well", async () => {
    const summary = await run([entry(3, f.users.manager.email)], {
      ENTRA_SYNC_MAX_DEACTIVATIONS: "1",
      ENTRA_SYNC_MAX_DEACTIVATION_PERCENT: "100",
    });

    assert.equal(summary.deactivated, 0);
    assert.match(summary.deactivationNote ?? "", /safety threshold/);
  });

  it("uses safe defaults and ignores invalid threshold values", () => {
    assert.deepEqual(deactivationThreshold({}), { maxCount: 25, maxPercent: 10 });
    assert.deepEqual(
      deactivationThreshold({ ENTRA_SYNC_MAX_DEACTIVATIONS: "-3", ENTRA_SYNC_MAX_DEACTIVATION_PERCENT: "lots" }),
      { maxCount: 25, maxPercent: 10 }
    );
    assert.deepEqual(
      deactivationThreshold({ ENTRA_SYNC_MAX_DEACTIVATIONS: "0", ENTRA_SYNC_MAX_DEACTIVATION_PERCENT: "5" }),
      { maxCount: 0, maxPercent: 5 }
    );
  });
});

describe("Entra sync deactivation never follows a failed or partial read (S-03)", () => {
  const ENV = {
    ...PERMISSIVE,
    ENTRA_TENANT_ID: "tenant",
    ENTRA_CLIENT_ID: "client",
    ENTRA_CLIENT_SECRET: "secret",
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // Token, then pages; `pages` decides what each Graph page returns.
  const graph = (pages: Response[]) => {
    let call = 0;

    return mock.fn(async () => (call++ === 0 ? json({ access_token: "t" }) : pages.shift()!));
  };

  async function failedSync(doFetch: ReturnType<typeof graph>) {
    const error = await syncEmployees({
      actorEmployeeId: f.users.admin.employeeId,
      env: ENV,
      doFetch: doFetch as unknown as typeof fetch,
    }).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(error instanceof SyncError, String(error));
  }

  it("a directory read that fails deactivates nobody", async () => {
    await failedSync(graph([json({ error: "boom" }, 500)]));

    assert.ok((await db.select().from(employee)).every((e) => e.is_active));
  });

  it("a read that fails on a later page deactivates nobody, even though page 1 was short", async () => {
    await failedSync(
      graph([
        json({
          value: [entry(3, f.users.manager.email)],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=x",
        }),
        json({ error: "throttled" }, 429),
      ])
    );

    assert.ok((await db.select().from(employee)).every((e) => e.is_active));

    const [row] = await db.select().from(employeeSyncRuns).orderBy(sql`id desc`).limit(1);
    assert.equal(row.status, "FAILED");
    assert.equal(row.deactivated, 0);
  });

  it("a complete multi-page read does deactivate", async () => {
    const doFetch = graph([
      json({
        value: [entry(2, f.users.carol.email)],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=x",
      }),
      json({ value: [entry(3, f.users.manager.email)] }),
    ]);

    const summary = await syncEmployees({
      actorEmployeeId: f.users.admin.employeeId,
      env: ENV,
      doFetch: doFetch as unknown as typeof fetch,
    });

    assert.equal(summary.deactivated, 1);
    assert.equal(await isActive(f.users.bob.employeeId), false);
  });
});
