import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  employeeSyncRuns,
  groupAuditLogs,
  userGroups,
} from "@/db/schema";
import { assignEmployee } from "@/lib/services/group.service";
import {
  getSyncStatus,
  SyncError,
  syncEmployees,
} from "@/lib/services/entra-sync.service";

import { seedFixtures, type Fixtures } from "../helpers/fixtures";

let f: Fixtures;

before(async () => {
  f = await seedFixtures();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE employee_sync_runs RESTART IDENTITY`);
  await db.update(employee).set({ entra_object_id: null });
});

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const entry = (n: number, email: string, name = `User ${n}`) => ({
  id: ID(n),
  displayName: name,
  mail: email,
  accountEnabled: true,
});

const run = (users: ReturnType<typeof entry>[]) =>
  syncEmployees({ actorEmployeeId: f.users.admin.employeeId, users });

const activeGroupOf = async (employeeId: number) =>
  (
    await db
      .select()
      .from(userGroups)
      .where(and(eq(userGroups.employeeId, employeeId), isNull(userGroups.effectiveUntil)))
  )[0]?.groupId ?? null;

const count = async () => (await db.select().from(employee)).length;

describe("Entra ID sync", () => {
  it("creates new employees with the Employee role and the Employee group", async () => {
    const before = await count();
    const summary = await run([entry(1, "new.one@example.test"), entry(2, "new.two@example.test")]);

    assert.equal(summary.created, 2);
    assert.equal(await count(), before + 2);

    const [created] = await db.select().from(employee).where(eq(employee.email, "new.one@example.test"));

    assert.equal(created.entra_object_id, ID(1));
    assert.equal(await activeGroupOf(created.employee_id), f.groupIds.employee);
    assert.ok(summary.assignedToDefault >= 2);
  });

  it("never creates a duplicate: a second run changes nothing", async () => {
    await run([entry(1, "new.one@example.test")]);

    const before = await count();
    const second = await run([entry(1, "new.one@example.test")]);

    assert.equal(await count(), before);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal((await db.select().from(employee).where(eq(employee.entra_object_id, ID(1)))).length, 1);
  });

  it("uses the object id as the identity: a changed e-mail and name update the same employee", async () => {
    await run([entry(1, "old@example.test", "Old Name")]);

    const [created] = await db.select().from(employee).where(eq(employee.entra_object_id, ID(1)));
    const before = await count();
    const summary = await run([entry(1, "renamed@example.test", "New Name")]);

    assert.equal(summary.updated, 1);
    assert.equal(await count(), before);

    const [after] = await db.select().from(employee).where(eq(employee.employee_id, created.employee_id));

    assert.equal(after.email, "renamed@example.test");
    assert.equal(after.employee_name, "New Name");
  });

  it("links an existing employee with the same e-mail instead of creating a second one", async () => {
    const before = await count();
    const [daveBefore] = await db.select().from(employee).where(eq(employee.employee_id, f.users.dave.employeeId));
    const summary = await run([entry(7, f.users.dave.email.toUpperCase(), "Dave From Entra")]);

    assert.equal(summary.linked, 1);
    assert.equal(summary.created, 0);
    assert.equal(await count(), before);

    const [dave] = await db.select().from(employee).where(eq(employee.employee_id, f.users.dave.employeeId));

    assert.equal(dave.entra_object_id, ID(7));
    assert.equal(dave.role_id, daveBefore.role_id, "the role is not touched");
  });

  it("keeps existing group assignments and roles", async () => {
    // Bob is moved to Leadership by an admin, then the sync runs.
    await assignEmployee(f.users.bob.employeeId, f.groupIds.leadership, f.users.admin.employeeId);

    const [bobBefore] = await db.select().from(employee).where(eq(employee.employee_id, f.users.bob.employeeId));

    await run([entry(11, f.users.bob.email, "Bob Renamed"), entry(12, f.users.manager.email)]);

    assert.equal(await activeGroupOf(f.users.bob.employeeId), f.groupIds.leadership, "Bob stays in Leadership");
    assert.equal(await activeGroupOf(f.users.manager.employeeId), f.groupIds.manager, "Mona stays a Manager");

    const [bobAfter] = await db.select().from(employee).where(eq(employee.employee_id, f.users.bob.employeeId));

    assert.equal(bobAfter.role_id, bobBefore.role_id);
    assert.equal(bobAfter.employee_name, "Bob Renamed");
  });

  it("places employees who have no group in the Employee group, with history and an audit row", async () => {
    // Every earlier sync in this file already placed Dave; start him ungrouped.
    await db.delete(userGroups).where(eq(userGroups.employeeId, f.users.dave.employeeId));

    assert.equal(await activeGroupOf(f.users.dave.employeeId), null);

    const summary = await run([]);

    assert.ok(summary.assignedToDefault >= 1);
    assert.equal(await activeGroupOf(f.users.dave.employeeId), f.groupIds.employee);

    const audit = (await db.select().from(groupAuditLogs)).filter((a) => a.action === "EMPLOYEES_DEFAULT_GROUP");

    assert.ok(audit.length >= 1);

    // Running again assigns nobody twice.
    const again = await run([]);

    assert.equal(again.assignedToDefault, 0);
    assert.equal(
      (await db.select().from(userGroups).where(and(eq(userGroups.employeeId, f.users.dave.employeeId), isNull(userGroups.effectiveUntil)))).length,
      1
    );

  });

  it("skips disabled accounts and people without a usable e-mail, and counts them", async () => {
    const before = await count();
    const summary = await run([
      { ...entry(21, "off@example.test"), accountEnabled: false },
      { ...entry(22, "not-an-email") },
      entry(23, "ok@example.test"),
    ]);

    assert.equal(summary.created, 1);
    assert.equal(summary.skipped, 2);
    assert.equal(await count(), before + 1);
  });

  it("does not take an e-mail that belongs to a different directory account", async () => {
    await run([entry(31, "shared@example.test")]);

    const before = await count();
    const summary = await run([entry(32, "shared@example.test")]);

    assert.equal(summary.skipped, 1);
    assert.equal(summary.created, 0);
    assert.equal(await count(), before);
  });

  it("does not delete employees that are missing from the directory", async () => {
    await run([entry(41, "gone@example.test")]);

    const before = await count();
    const summary = await run([entry(42, "someone.else@example.test")]);

    assert.equal(summary.notInDirectory, 1);
    assert.equal(await count(), before + 1, "nobody was removed");
  });

  it("records every run: progress, the last success and failures", async () => {
    assert.equal((await getSyncStatus({})).lastSuccessAt, null);

    await run([entry(51, "status@example.test")]);

    const status = await getSyncStatus({});

    assert.ok(status.lastSuccessAt);
    assert.equal(status.last?.status, "SUCCESS");
    assert.equal(status.last?.created, 1);
    assert.equal(status.running, false);
    assert.equal(status.configured, false);
    assert.match(status.configProblem ?? "", /ENTRA_TENANT_ID/);
  });

  it("allows one sync at a time", async () => {
    await db.insert(employeeSyncRuns).values({ status: "RUNNING" });

    const error = await run([entry(61, "blocked@example.test")]).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(error instanceof SyncError);
    assert.equal(error.status, 409);
  });

  it("closes a run that never finished so it cannot block syncs forever", async () => {
    await db.execute(
      sql`INSERT INTO employee_sync_runs (status, started_at) VALUES ('RUNNING', now() - interval '2 hours')`
    );

    const summary = await run([entry(71, "after.crash@example.test")]);

    assert.equal(summary.created, 1);

    const rows = await db.select().from(employeeSyncRuns);

    assert.ok(rows.some((r) => r.status === "FAILED" && /did not finish/.test(r.error ?? "")));
  });

  it("refuses to run, without recording anything, when Entra is not configured", async () => {
    const error = await syncEmployees({ actorEmployeeId: f.users.admin.employeeId, env: {} }).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(error instanceof SyncError);
    assert.equal(error.status, 503);
    assert.equal((await db.select().from(employeeSyncRuns)).length, 0);
  });
});
