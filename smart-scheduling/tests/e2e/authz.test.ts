import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { employee, meeting, meeting_attendees, roles, room } from "@/db/schema";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { isRedirect, startApp, type App } from "./harness";

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3192);
});

after(() => app?.stop());

const roleId = async (name: string) =>
  (await db.select().from(roles).where(eq(roles.roleName, name)))[0].roleId;

// Bob (organizer) books a meeting with the manager as an attendee.
async function bobsMeeting(startTime = "10:00", endTime = "11:00", date = dateFromToday(9)) {
  const res = await app.call("POST", "/api/meetings/booking", {
    as: f.users.bob,
    body: {
      title: "Bob's private review",
      meeting_date: date,
      room_id: f.rooms.alpha.room_id,
      participant_count: 3,
      meeting_type_id: f.types.team,
      start_time: startTime,
      end_time: endTime,
      participantEmployeeIds: [f.users.manager.employeeId],
    },
  });

  assert.equal(res.status, 201, res.text);

  return res.json!.meetingId as number;
}

const newRoom = { roomName: "Omega", roomCapacity: 6, roomLocation: "Floor 9", availabilityStatusId: 1 };

describe("administrator-only operations", () => {
  it("an administrator can manage rooms", async () => {
    const created = await app.call("POST", "/api/rooms", { as: f.users.admin, body: newRoom });
    assert.equal(created.status, 201);

    const id = (created.json as unknown as { room_id: number }[])[0].room_id;

    assert.equal(
      (await app.call("PATCH", `/api/rooms/${id}`, { as: f.users.admin, body: { ...newRoom, roomCapacity: 7 } })).status,
      200
    );
    assert.equal((await app.call("DELETE", `/api/rooms/${id}`, { as: f.users.admin })).status, 200);
  });

  it("employees are refused (403) and nothing changes", async () => {
    const before = (await db.select().from(room)).length;

    for (const user of [f.users.bob, f.users.manager]) {
      assert.equal((await app.call("POST", "/api/rooms", { as: user, body: newRoom })).status, 403);
      assert.equal((await app.call("PATCH", "/api/rooms/1", { as: user, body: newRoom })).status, 403);
      assert.equal((await app.call("DELETE", "/api/rooms/1", { as: user })).status, 403);
      assert.equal(
        (await app.call("PATCH", "/api/rooms/1/edit", {
          as: user,
          body: { room_name: "hacked", room_capacity: 1, roomLocation: "x", availabilityStatusId: 1 },
        })).status,
        403
      );
    }

    assert.equal((await db.select().from(room)).length, before);
    assert.equal((await db.select().from(room).where(eq(room.room_id, 1)))[0].room_name, "Alpha");
  });

  it("a DEMOTED administrator keeps no administrative access, with the same still-valid session (F-07)", async () => {
    const adminSession = { as: f.users.admin };

    assert.equal(
      (await app.call("POST", "/api/rooms", { ...adminSession, body: { ...newRoom, roomName: "before demotion" } })).status,
      201
    );

    await db
      .update(employee)
      .set({ role_id: await roleId("Employee") })
      .where(eq(employee.employee_id, f.users.admin.employeeId));

    try {
      assert.equal((await app.call("POST", "/api/rooms", { ...adminSession, body: newRoom })).status, 403);
      assert.equal((await app.call("PATCH", "/api/rooms/1", { ...adminSession, body: newRoom })).status, 403);
      assert.equal((await app.call("DELETE", "/api/rooms/1", { ...adminSession })).status, 403);
      assert.equal(
        (await app.call("PATCH", "/api/rooms/1/edit", {
          ...adminSession,
          body: { room_name: "x", room_capacity: 2, roomLocation: "x", availabilityStatusId: 1 },
        })).status,
        403
      );

      // the admin-only page redirects too
      const page = await app.call("GET", "/rooms/1/edit", adminSession);
      assert.ok(isRedirect(page.status));
      assert.match(page.location ?? "", /\/rooms$/);
    } finally {
      await db
        .update(employee)
        .set({ role_id: await roleId("Admin") })
        .where(eq(employee.employee_id, f.users.admin.employeeId));
    }

    // …and a (re)promoted admin is recognised again without a new sign-in.
    assert.equal((await app.call("POST", "/api/rooms", { ...adminSession, body: { ...newRoom, roomName: "after" } })).status, 201);
  });
});

describe("room input validation (F-16)", () => {
  const admin = () => ({ as: f.users.admin });

  it("rejects invalid rooms with 400, not 500 or silent acceptance", async () => {
    const bad: unknown[] = [
      { ...newRoom, roomCapacity: -5 },
      { ...newRoom, roomCapacity: 0 },
      { ...newRoom, roomCapacity: 1_000_000_000 },
      { ...newRoom, roomCapacity: 2 ** 31 },
      { ...newRoom, roomName: "   " },
      { ...newRoom, roomName: "x".repeat(101) },
      { roomCapacity: 3, availabilityStatusId: 1 },
      { ...newRoom, availabilityStatusId: 999 },
    ];

    for (const body of bad) {
      const res = await app.call("POST", "/api/rooms", { ...admin(), body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
    }
  });

  it("PATCH/GET/DELETE of a missing room is 404, a malformed id 400", async () => {
    assert.equal((await app.call("PATCH", "/api/rooms/99999", { ...admin(), body: newRoom })).status, 404);
    assert.equal((await app.call("DELETE", "/api/rooms/99999", admin())).status, 404);
    assert.equal((await app.call("GET", "/api/rooms/99999", admin())).status, 404);
    assert.equal((await app.call("GET", "/api/rooms/abc", admin())).status, 400);
  });

  it("deleting a room that has meetings is 409 (was 500) and keeps the data", async () => {
    await bobsMeeting("15:00", "16:00", dateFromToday(20));

    const res = await app.call("DELETE", `/api/rooms/${f.rooms.alpha.room_id}`, admin());

    assert.equal(res.status, 409);
    assert.equal((await db.select().from(room).where(eq(room.room_id, f.rooms.alpha.room_id))).length, 1);
  });

  it("capacity cannot be cut below an upcoming meeting in the room", async () => {
    await bobsMeeting("17:00", "18:00", dateFromToday(21));

    const res = await app.call("PATCH", `/api/rooms/${f.rooms.alpha.room_id}/edit`, {
      ...admin(),
      body: { room_name: "Alpha", room_capacity: 2, roomLocation: "Floor 1", availabilityStatusId: 1 },
    });

    assert.equal(res.status, 409);
  });
});

describe("ownership of meetings", () => {
  it("only the organizer or an admin may edit or cancel; others get 403 and nothing changes", async () => {
    const id = await bobsMeeting("09:00", "10:00", dateFromToday(10));

    for (const stranger of [f.users.carol, f.users.manager]) {
      const edit = await app.call("PATCH", `/api/meetings/edit/${id}`, { as: stranger, body: { title: "hijacked" } });
      const cancel = await app.call("PATCH", `/api/meetings/cancel/${id}`, { as: stranger });

      assert.equal(edit.status, 403);
      assert.equal(cancel.status, 403);
    }

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, id));
    assert.equal(row.title, "Bob's private review");
    assert.equal(row.meetingStatusId, 1);

    // the organizer can
    assert.equal((await app.call("PATCH", `/api/meetings/edit/${id}`, { as: f.users.bob, body: { title: "Renamed by Bob" } })).status, 200);
    // an administrator can too
    assert.equal((await app.call("PATCH", `/api/meetings/edit/${id}`, { as: f.users.admin, body: { title: "Renamed by Admin" } })).status, 200);
    assert.equal((await app.call("PATCH", `/api/meetings/cancel/${id}`, { as: f.users.admin })).status, 200);
    assert.equal((await app.call("PATCH", `/api/meetings/cancel/${id}`, { as: f.users.bob })).status, 400, "already cancelled");
  });

  it("the organizer comes from the session, never from the body", async () => {
    const res = await app.call("POST", "/api/meetings/booking", {
      as: f.users.carol,
      body: {
        title: "Spoof attempt",
        meeting_date: dateFromToday(11),
        organizer_employee_id: f.users.bob.employeeId,
        meeting_status_id: 3,
        room_id: f.rooms.alpha.room_id,
        participant_count: 1,
        meeting_type_id: f.types.others,
        start_time: "13:00",
        end_time: "14:00",
      },
    });

    assert.equal(res.status, 201);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, res.json!.meetingId as number));
    assert.equal(row.organizerEmployeeId, f.users.carol.employeeId);
    assert.equal(row.meetingStatusId, 1);
  });
});

describe("object-level access to meeting pages and titles (F-08)", () => {
  it("organizer, attendee and admin may view; an unrelated employee is redirected", async () => {
    const id = await bobsMeeting("11:00", "12:00", dateFromToday(12));

    for (const [user, expected] of [
      [f.users.bob, 200],
      [f.users.manager, 200], // attendee
      [f.users.admin, 200],
    ] as const) {
      const res = await app.call("GET", `/bookings/${id}`, { as: user });
      assert.equal(res.status, expected, user.email);
      assert.ok(res.text.includes("Bob&#x27;s private review") || res.text.includes("Bob's private review"));
    }

    const other = await app.call("GET", `/bookings/${id}`, { as: f.users.carol });
    assert.ok(isRedirect(other.status), `carol got ${other.status}`);
    assert.match(other.location ?? "", /\/bookings$/);
    assert.ok(!other.text.includes("private review"), "no title leaks in the redirect body");

    // same response as for a meeting that does not exist: ids cannot be probed
    const missing = await app.call("GET", "/bookings/987654", { as: f.users.carol });
    assert.equal(missing.status, other.status);
    assert.equal(missing.location, other.location);
  });

  it("the edit form is only for the organizer and admins — not attendees or others", async () => {
    const id = await bobsMeeting("12:00", "13:00", dateFromToday(13));

    assert.equal((await app.call("GET", `/bookings/${id}/edit`, { as: f.users.bob })).status, 200);
    assert.equal((await app.call("GET", `/bookings/${id}/edit`, { as: f.users.admin })).status, 200);

    for (const user of [f.users.manager, f.users.carol]) {
      const res = await app.call("GET", `/bookings/${id}/edit`, { as: user });
      assert.ok(isRedirect(res.status), `${user.email} -> ${res.status}`);
      assert.ok(!res.text.includes("private review"));
    }
  });

  it("the room schedule shows titles only to participants and admins; others see Busy", async () => {
    const date = dateFromToday(14);
    await bobsMeeting("14:00", "15:00", date);
    const url = `/api/rooms/${f.rooms.alpha.room_id}/schedule?date=${date}`;

    const titles = async (user: typeof f.users.bob) =>
      ((await app.call("GET", url, { as: user })).json!.data as { title: string }[]).map((s) => s.title);

    assert.deepEqual(await titles(f.users.bob), ["Bob's private review"]);
    assert.deepEqual(await titles(f.users.manager), ["Bob's private review"]); // attendee
    assert.deepEqual(await titles(f.users.admin), ["Bob's private review"]);
    assert.deepEqual(await titles(f.users.carol), ["Busy"]);

    const times = ((await app.call("GET", url, { as: f.users.carol })).json!.data as { startTime: string }[]);
    assert.equal(times[0].startTime, "14:00:00", "the time range stays visible");
  });

  it("attendees listed on a meeting do not gain edit rights (403 on the API too)", async () => {
    const id = await bobsMeeting("16:00", "17:00", dateFromToday(15));
    const attendees = await db.select().from(meeting_attendees).where(eq(meeting_attendees.meeting_id, id));

    assert.ok(attendees.some((a) => a.employee_id === f.users.manager.employeeId));
    assert.equal(
      (await app.call("PATCH", `/api/meetings/edit/${id}`, { as: f.users.manager, body: { title: "x" } })).status,
      403
    );
  });
});
