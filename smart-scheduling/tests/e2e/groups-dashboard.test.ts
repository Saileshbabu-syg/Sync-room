import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  groups,
  meeting,
  organizers,
  roles,
  userGroups,
} from "@/db/schema";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { isRedirect, startApp, type App } from "./harness";

let app: App;
let f: Fixtures;
let viewer: { employeeId: number; email: string; name: string; role: string };

before(async () => {
  f = await seedFixtures();
  app = await startApp(3197);

  // Vera: placed in the group that holds dashboard.view by default.
  const [role] = await db.select().from(roles).where(eq(roles.roleName, "HR"));
  const [emp] = await db
    .insert(employee)
    .values({ role_id: role.roleId, employee_name: "Vera Viewer", email: "vera.viewer@example.test" })
    .returning();

  await db.insert(organizers).values({
    employeeId: emp.employee_id,
    name: "Vera Viewer",
    email: "vera.viewer@example.test",
    role: "HR",
    provider: "google",
  });
  await db.insert(userGroups).values({ employeeId: emp.employee_id, groupId: f.groupIds.hr });

  viewer = { employeeId: emp.employee_id, email: "vera.viewer@example.test", name: "Vera Viewer", role: "HR" };
});

after(() => app?.stop());

const week = "mode=week&date=2031-03-05";

describe("group administration is Admin-only", () => {
  it("an administrator can list, create and edit groups", async () => {
    const list = await app.call("GET", "/api/admin/groups", { as: f.users.admin });

    assert.equal(list.status, 200);
    assert.equal((list.json!.groups as unknown[]).length, 6);

    const created = await app.call("POST", "/api/admin/groups", {
      as: f.users.admin,
      body: { name: "Contractors", description: "External", priority: 6, isActive: true, permissions: ["booking.view"] },
    });

    assert.equal(created.status, 201, created.text);

    const id = (created.json!.group as { id: number }).id;
    const edited = await app.call("PATCH", `/api/admin/groups/${id}`, {
      as: f.users.admin,
      body: { description: "External staff", priority: 7 },
    });

    assert.equal(edited.status, 200);
    assert.equal((edited.json!.group as { priority: number }).priority, 7);

    assert.equal((await app.call("DELETE", `/api/admin/groups/${id}`, { as: f.users.admin })).status, 200);
  });

  it("everyone else is refused and nothing changes", async () => {
    const before = (await db.select().from(groups)).length;

    // Even someone who may use the dashboard cannot manage groups.
    for (const user of [f.users.bob, f.users.manager, viewer]) {
      assert.equal((await app.call("GET", "/api/admin/groups", { as: user })).status, 403);
      assert.equal(
        (await app.call("POST", "/api/admin/groups", {
          as: user,
          body: { name: "Hackers", priority: 1, isActive: true, permissions: ["dashboard.view"] },
        })).status,
        403
      );
      assert.equal(
        (await app.call("PATCH", `/api/admin/groups/${f.groupIds.employee}`, { as: user, body: { priority: 1 } })).status,
        403
      );
      assert.equal((await app.call("DELETE", `/api/admin/groups/${f.groupIds.tl}`, { as: user })).status, 403);
      assert.equal(
        (await app.call("PUT", `/api/admin/employees/${user.employeeId}/group`, { as: user, body: { groupId: f.groupIds.leadership } })).status,
        403
      );
      assert.equal((await app.call("GET", "/api/admin/employees", { as: user })).status, 403);
    }

    assert.equal((await db.select().from(groups)).length, before);

    const [bob] = await db.select().from(userGroups).where(eq(userGroups.employeeId, f.users.bob.employeeId));
    assert.equal(bob.groupId, f.groupIds.employee, "Bob did not promote himself");
  });

  it("anonymous requests get 401", async () => {
    assert.equal((await app.call("GET", "/api/admin/groups")).status, 401);
    assert.equal((await app.call("GET", "/api/admin/employees")).status, 401);
  });

  it("validates input and rejects cross-site requests", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      app.call("POST", "/api/admin/groups", { as: f.users.admin, body, headers });

    assert.equal((await post({ name: "", priority: 1 })).status, 400);
    assert.equal((await post({ name: "X", priority: 0 })).status, 400);
    assert.equal((await post({ name: "X", priority: 1.5 })).status, 400);
    assert.equal((await post({ name: "X", priority: 1, permissions: ["root.everything"] })).status, 400);
    assert.equal((await post({ name: "Employee", priority: 6 })).status, 409, "duplicate name");
    assert.equal((await post({ name: "Evil", priority: 6 }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await app.call("PATCH", "/api/admin/groups/abc", { as: f.users.admin, body: { name: "x" } })).status, 400);
  });

  it("assigns employees, refuses inactive groups, and keeps one group per employee", async () => {
    const put = (employeeId: number, groupId: number) =>
      app.call("PUT", `/api/admin/employees/${employeeId}/group`, { as: f.users.admin, body: { groupId } });

    assert.equal((await put(f.users.dave.employeeId, f.groupIds.tl)).status, 200);
    assert.equal((await put(f.users.dave.employeeId, f.groupIds.manager)).status, 200);

    const active = (await db.select().from(userGroups).where(eq(userGroups.employeeId, f.users.dave.employeeId)))
      .filter((r) => r.effectiveUntil === null);
    assert.equal(active.length, 1);
    assert.equal(active[0].groupId, f.groupIds.manager);

    await app.call("PATCH", `/api/admin/groups/${f.groupIds.tl}`, { as: f.users.admin, body: { isActive: false } });
    assert.equal((await put(f.users.carol.employeeId, f.groupIds.tl)).status, 409);
    await app.call("PATCH", `/api/admin/groups/${f.groupIds.tl}`, { as: f.users.admin, body: { isActive: true } });

    const found = await app.call("GET", "/api/admin/employees?search=dave", { as: f.users.admin });
    assert.equal(found.status, 200);
    assert.equal((found.json!.rows as { groupName: string }[])[0].groupName, "Manager");
  });
});

describe("dashboard access follows the group permission", () => {
  it("someone with the dashboard permission can read bookings and metrics", async () => {
    const res = await app.call("GET", `/api/dashboard/bookings?${week}`, { as: viewer });

    assert.equal(res.status, 200, res.text);
    assert.equal((res.json!.period as { start: string }).start, "2031-03-05");
    assert.equal((res.json!.period as { end: string }).end, "2031-03-11");
    assert.ok("totalBookings" in (res.json!.metrics as object));
  });

  it("employees, managers and even Admin (no group permission) are refused", async () => {
    for (const user of [f.users.bob, f.users.manager, f.users.admin]) {
      assert.equal((await app.call("GET", `/api/dashboard/bookings?${week}`, { as: user })).status, 403, user.name);
      assert.equal((await app.call("GET", `/api/dashboard/report?${week}&format=csv`, { as: user })).status, 403, user.name);
    }

    assert.equal((await app.call("GET", `/api/dashboard/bookings?${week}`)).status, 401);
    assert.equal((await app.call("GET", `/api/dashboard/report?${week}&format=csv`)).status, 401);
  });

  it("pages are hidden by redirect for those without the permission", async () => {
    const denied = await app.call("GET", "/dashboard", { as: f.users.bob });
    assert.ok(isRedirect(denied.status), `status ${denied.status}`);
    assert.match(denied.location ?? "", /\/home$/);

    const allowed = await app.call("GET", "/dashboard", { as: viewer });
    assert.equal(allowed.status, 200);

    const notAdmin = await app.call("GET", "/admin/groups", { as: viewer });
    assert.ok(isRedirect(notAdmin.status));
    assert.equal((await app.call("GET", "/admin/groups", { as: f.users.admin })).status, 200);
  });

  it("rejects invalid periods and filters", async () => {
    const get = (qs: string) => app.call("GET", `/api/dashboard/bookings?${qs}`, { as: viewer });

    assert.equal((await get("mode=range&start=2031-03-10&end=2031-03-01")).status, 400);
    assert.equal((await get("mode=range&start=2031-03-01")).status, 400);
    assert.equal((await get("mode=month&date=2031-13-01")).status, 400);
    assert.equal((await get(`${week}&statusId=6`)).status, 200, "Replaced is a dashboard status");
    assert.equal((await get("mode=day&date=2031-02-30")).status, 400);
    assert.equal((await get("mode=year")).status, 400);
    assert.equal((await get(`${week}&statusId=99`)).status, 400);
    assert.equal((await get(`${week}&groupId=abc`)).status, 400);
  });

  it("an Admin can grant the dashboard to another group, and withdraw it", async () => {
    const setPermissions = (permissions: string[]) =>
      app.call("PATCH", `/api/admin/groups/${f.groupIds.manager}`, { as: f.users.admin, body: { permissions } });

    assert.equal((await app.call("GET", `/api/dashboard/bookings?${week}`, { as: f.users.manager })).status, 403);

    await setPermissions(["dashboard.view", "booking.create", "booking.view", "booking.cancel", "booking.priority"]);
    assert.equal((await app.call("GET", `/api/dashboard/bookings?${week}`, { as: f.users.manager })).status, 200);

    await setPermissions(["booking.create", "booking.view", "booking.cancel", "booking.priority"]);
    assert.equal((await app.call("GET", `/api/dashboard/bookings?${week}`, { as: f.users.manager })).status, 403);
  });
});

describe("Group Management is a permission", () => {
  const all = ["booking.create", "booking.view", "booking.cancel", "booking.priority"];
  const setPermissions = (permissions: string[]) =>
    app.call("PATCH", `/api/admin/groups/${f.groupIds.manager}`, { as: f.users.admin, body: { permissions } });

  it("lets a group that was granted it use every Group Management API and page, and stops when it is withdrawn", async () => {
    const mona = f.users.manager;
    const apis = () =>
      Promise.all([
        app.call("GET", "/api/admin/groups", { as: mona }),
        app.call("GET", "/api/admin/employees", { as: mona }),
        app.call("GET", "/api/admin/employees/sync", { as: mona }),
      ]);

    assert.deepEqual((await apis()).map((r) => r.status), [403, 403, 403], "not granted by default");
    assert.ok(isRedirect((await app.call("GET", "/admin/groups", { as: mona })).status));

    await setPermissions([...all, "group.manage"]);

    assert.deepEqual((await apis()).map((r) => r.status), [200, 200, 200]);
    assert.equal((await app.call("GET", "/admin/groups", { as: mona })).status, 200);

    await setPermissions(all);

    assert.deepEqual((await apis()).map((r) => r.status), [403, 403, 403], "withdrawn: effective on the next request");
  });

  it("an unauthenticated caller is refused, and the Admin role keeps access whatever the group says", async () => {
    assert.equal((await app.call("GET", "/api/admin/groups")).status, 401);

    // Alice has the Admin role and no group at all.
    assert.equal((await app.call("GET", "/api/admin/groups", { as: f.users.admin })).status, 200);
  });
});

describe("new group controls are enforced on the server", () => {
  const base = ["booking.create", "booking.view", "booking.cancel", "booking.priority", "booking.recurring"];
  const setPermissions = (permissions: string[]) =>
    app.call("PATCH", `/api/admin/groups/${f.groupIds.manager}`, { as: f.users.admin, body: { permissions } });

  it("room management needs rooms.manage (the Admin role keeps it)", async () => {
    const patch = (as: typeof f.users.manager) =>
      app.call("PATCH", `/api/rooms/${f.rooms.alpha.room_id}`, { as, body: {} });

    await setPermissions(base);

    assert.equal((await patch(f.users.manager)).status, 403);

    await setPermissions([...base, "rooms.manage"]);

    const allowed = await patch(f.users.manager);

    assert.notEqual(allowed.status, 403, "authorised: the empty body is then rejected as invalid, not as forbidden");
    assert.notEqual(allowed.status, 401);

    await setPermissions(base);

    assert.equal((await patch(f.users.manager)).status, 403, "withdrawn");
    assert.notEqual((await patch(f.users.admin)).status, 403, "the Admin role is not affected");
  });

  it("Entra settings and the directory group list are behind Group Management", async () => {
    for (const path of ["/api/admin/entra/settings", "/api/admin/entra/groups"]) {
      assert.equal((await app.call("GET", path)).status, 401);
      assert.equal((await app.call("GET", path, { as: f.users.bob })).status, 403);
    }

    assert.equal((await app.call("GET", "/api/admin/entra/settings", { as: f.users.admin })).status, 200);

    const save = (as: typeof f.users.admin | typeof f.users.bob, body: unknown) =>
      app.call("PUT", "/api/admin/entra/settings", { as, body });

    assert.equal((await save(f.users.bob, { autoSyncEnabled: true, intervalHours: 6, mappings: [] })).status, 403);
    assert.equal((await save(f.users.admin, { autoSyncEnabled: true, intervalHours: 0, mappings: [] })).status, 400);
    assert.equal((await save(f.users.admin, { autoSyncEnabled: true, intervalHours: 6, mappings: [] })).status, 200);
    assert.equal(
      (await app.call("GET", "/api/admin/entra/settings", { as: f.users.admin })).json!.settings
        ? ((await app.call("GET", "/api/admin/entra/settings", { as: f.users.admin })).json!.settings as { intervalHours: number }).intervalHours
        : 0,
      6
    );
  });

  it("the booking form is told what the group allows, and recurring bookings are refused on the server without it", async () => {
    const policy = async () =>
      (await app.call("GET", "/api/booking-policy", { as: f.users.manager })).json!.policy as {
        canBookRecurring: boolean;
        maxDurationMinutes: number | null;
      };

    await setPermissions(base);
    assert.equal((await policy()).canBookRecurring, true);

    await setPermissions(base.filter((p) => p !== "booking.recurring"));
    assert.equal((await policy()).canBookRecurring, false);

    const series = await app.call("POST", "/api/meetings/recurring", {
      as: f.users.manager,
      body: {
        title: "Weekly sync",
        room_id: f.rooms.alpha.room_id,
        meeting_date: dateFromToday(9),
        start_time: "10:00",
        end_time: "11:00",
        participantCount: 1,
        meetingTypeId: f.types.team,
        frequency_id: 2,
        occurrence_count: 2,
      },
    });

    assert.equal(series.status, 403, series.text);

    await setPermissions(base);
    assert.equal((await app.call("GET", "/api/booking-policy")).status, 401);
  });
});

describe("report downloads", () => {
  const download = (format: string, qs = week) =>
    app.call("GET", `/api/dashboard/report?${qs}&format=${format}`, { as: viewer });

  it("serves CSV, Excel and PDF as attachments named after the period", async () => {
    const csv = await download("csv");
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(csv.headers.get("content-disposition") ?? "", /attachment; filename="booking-report_2031-03-05_to_2031-03-11\.csv"/);
    assert.match(csv.headers.get("cache-control") ?? "", /no-store/);
    assert.match(csv.text, /Total bookings,/);

    const xlsx = await download("xlsx");
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get("content-type") ?? "", /spreadsheetml\.sheet/);

    const pdf = await download("pdf");
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.ok(pdf.text.startsWith("%PDF-"));
  });

  it("rejects an unknown format and an invalid period", async () => {
    assert.equal((await download("docx")).status, 400);
    assert.equal((await download("csv", "mode=range&start=bad&end=bad")).status, 400);
  });

  it("contains the same records the dashboard filters select", async () => {
    const date = dateFromToday(3);

    for (const [title, start, end, status] of [
      ["Visible one", "09:00", "10:00", 1],
      ["Visible two", "11:00", "12:00", 3],
      ["Other day", "09:00", "10:00", 1],
    ] as const) {
      await db.insert(meeting).values({
        title,
        room_id: f.rooms.alpha.room_id,
        meeting_date: title === "Other day" ? dateFromToday(4) : date,
        organizerEmployeeId: f.users.bob.employeeId,
        participantCount: 1,
        meetingTypeId: f.types.team,
        meetingStatusId: status,
        start_time: start,
        end_time: end,
        groupIdAtBooking: f.groupIds.employee,
        priorityAtBooking: 5,
      });
    }

    const qs = `mode=day&date=${date}`;
    const screen = await app.call("GET", `/api/dashboard/bookings?${qs}`, { as: viewer });
    const rows = screen.json!.rows as { title: string }[];
    const csv = (await download("csv", qs)).text;

    assert.deepEqual(rows.map((r) => r.title).sort(), ["Visible one", "Visible two"]);

    for (const r of rows) assert.ok(csv.includes(r.title), r.title);
    assert.ok(!csv.includes("Other day"));

    // Same filters, narrower: cancelled only.
    const narrow = (await download("csv", `${qs}&statusId=3`)).text;
    assert.ok(narrow.includes("Visible two") && !narrow.includes("Visible one"));
  });
});

describe("priority cannot be spoofed by the client", () => {
  it("ignores a group or priority sent in the booking request", async () => {
    const res = await app.call("POST", "/api/meetings/booking", {
      as: f.users.bob,
      body: {
        title: "Sneaky",
        meeting_date: dateFromToday(11),
        room_id: f.rooms.beta.room_id,
        participant_count: 1,
        meeting_type_id: f.types.team,
        start_time: "10:00",
        end_time: "11:00",
        priority_at_booking: 1,
        group_id_at_booking: f.groupIds.leadership,
        groupId: f.groupIds.leadership,
        priority: 1,
      },
    });

    assert.ok([201, 400].includes(res.status), res.text);

    if (res.status === 201) {
      const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, res.json!.meetingId as number));

      assert.equal(row.priorityAtBooking, 5);
      assert.equal(row.groupIdAtBooking, f.groupIds.employee);
    }
  });
});
