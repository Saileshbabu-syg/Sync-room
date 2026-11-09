import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { employee, groupPermissions, groups } from "@/db/schema";
import { PERMISSION } from "@/lib/constants";

import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { isRedirect, startApp, type App } from "./harness";

// Phase 1 security hardening, end to end over real HTTP: S-02 at the API
// layer, S-03 for a still-valid session, S-07 for the anonymous invitation
// endpoint.

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();

  // Mona (Manager group) becomes a non-Admin group manager.
  await db
    .update(groupPermissions)
    .set({ isEnabled: true })
    .where(
      and(
        eq(groupPermissions.groupId, f.groupIds.manager),
        eq(groupPermissions.permissionKey, PERMISSION.GROUP_MANAGE)
      )
    );

  app = await startApp(3199);
});

after(() => app?.stop());

const priorityOf = async (groupId: number) =>
  (await db.select({ p: groups.priority }).from(groups).where(eq(groups.id, groupId)))[0].p;

describe("group management API (S-02)", () => {
  it("a non-Admin group manager gets 403 for priority and permission changes, and nothing changes", async () => {
    const before = await priorityOf(f.groupIds.employee);

    const priority = await app.call("PATCH", `/api/admin/groups/${f.groupIds.employee}`, {
      as: f.users.manager,
      body: { priority: 1 },
    });
    assert.equal(priority.status, 403, priority.text);

    const grant = await app.call("PATCH", `/api/admin/groups/${f.groupIds.manager}`, {
      as: f.users.manager,
      body: { permissions: [PERMISSION.BOOKING_OUTRANKS, PERMISSION.GROUP_MANAGE] },
    });
    assert.equal(grant.status, 403, grant.text);

    const move = await app.call("PUT", `/api/admin/employees/${f.users.manager.employeeId}/group`, {
      as: f.users.manager,
      body: { groupId: f.groupIds.leadership },
    });
    assert.equal(move.status, 403, move.text);

    assert.equal(await priorityOf(f.groupIds.employee), before);
  });

  it("an Admin still can", async () => {
    const res = await app.call("PATCH", `/api/admin/groups/${f.groupIds.tl}`, {
      as: f.users.admin,
      body: { priority: 4 },
    });

    assert.equal(res.status, 200, res.text);
  });
});

describe("deactivated employee (S-03)", () => {
  it("a session issued before deactivation stops working at once", async () => {
    const ok = await app.call("GET", "/api/meeting-types", { as: f.users.carol });
    assert.equal(ok.status, 200);

    await db.update(employee).set({ is_active: false }).where(eq(employee.employee_id, f.users.carol.employeeId));

    const api = await app.call("POST", "/api/meetings/booking", { as: f.users.carol, body: {} });
    assert.equal(api.status, 401);

    const page = await app.call("GET", "/home", { as: f.users.carol });
    assert.ok(isRedirect(page.status) && /\/login/.test(page.location ?? ""), `${page.status} ${page.location}`);
  });
});

describe("invitation rate limit without a trusted proxy (S-07)", () => {
  it("a client cannot get a fresh bucket by inventing X-Forwarded-For values", async () => {
    const statuses: number[] = [];

    for (let i = 0; i < 32; i++) {
      const res = await app.call("POST", "/api/invitations/respond", {
        headers: { "x-forwarded-for": `198.51.100.${i}` },
        body: {},
      });

      statuses.push(res.status);
    }

    assert.ok(statuses.slice(0, 30).every((s) => s === 400), statuses.join(","));
    assert.ok(statuses.slice(30).every((s) => s === 429), statuses.join(","));
  });
});
