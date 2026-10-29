import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { employee, organizers, roles } from "@/db/schema";
import { resolveOrganizerByEmail } from "@/lib/services/identity.service";

import { seedFixtures, type Fixtures } from "../helpers/fixtures";

let f: Fixtures;

before(async () => {
  f = await seedFixtures();
});

const roleId = async (name: string) =>
  (await db.select().from(roles).where(eq(roles.roleName, name)))[0].roleId;

describe("current identity is resolved from the Employee record (F-07)", () => {
  it("returns the organizer with the current role", async () => {
    const admin = await resolveOrganizerByEmail(f.users.admin.email);

    assert.equal(admin?.employeeId, f.users.admin.employeeId);
    assert.equal(admin?.role, "Admin");
    assert.equal((await resolveOrganizerByEmail(f.users.bob.email))?.role, "Employee");
  });

  it("a demoted administrator loses admin immediately — even though Organizer.role still says Admin", async () => {
    const employeeRoleId = await roleId("Employee");

    await db
      .update(employee)
      .set({ role_id: employeeRoleId })
      .where(eq(employee.employee_id, f.users.admin.employeeId));

    try {
      const [cached] = await db
        .select()
        .from(organizers)
        .where(eq(organizers.email, f.users.admin.email));

      assert.equal(cached.role, "Admin", "the stale cached copy is untouched");

      const resolved = await resolveOrganizerByEmail(f.users.admin.email);
      assert.equal(resolved?.role, "Employee");
    } finally {
      await db
        .update(employee)
        .set({ role_id: await roleId("Admin") })
        .where(eq(employee.employee_id, f.users.admin.employeeId));
    }

    assert.equal((await resolveOrganizerByEmail(f.users.admin.email))?.role, "Admin");
  });

  it("a promotion also takes effect immediately", async () => {
    await db
      .update(employee)
      .set({ role_id: await roleId("Manager") })
      .where(eq(employee.employee_id, f.users.carol.employeeId));

    try {
      assert.equal((await resolveOrganizerByEmail(f.users.carol.email))?.role, "Manager");
    } finally {
      await db
        .update(employee)
        .set({ role_id: await roleId("Employee") })
        .where(eq(employee.employee_id, f.users.carol.employeeId));
    }
  });

  it("fails closed when the Employee email no longer matches (offboarded / changed)", async () => {
    await db
      .update(employee)
      .set({ email: "someone.else@example.test" })
      .where(eq(employee.employee_id, f.users.bob.employeeId));

    try {
      assert.equal(await resolveOrganizerByEmail(f.users.bob.email), null);
    } finally {
      await db
        .update(employee)
        .set({ email: f.users.bob.email })
        .where(eq(employee.employee_id, f.users.bob.employeeId));
    }

    assert.ok(await resolveOrganizerByEmail(f.users.bob.email));
  });

  it("returns null for unknown emails and employees that never signed in", async () => {
    assert.equal(await resolveOrganizerByEmail("ghost@example.test"), null);
    assert.equal(await resolveOrganizerByEmail(f.users.dave.email), null);
    assert.equal(await resolveOrganizerByEmail(""), null);
  });

  it("is not fooled by SQL metacharacters in the email", async () => {
    assert.equal(await resolveOrganizerByEmail("' OR '1'='1"), null);
    assert.equal(await resolveOrganizerByEmail(`${f.users.bob.email}' --`), null);
  });
});
