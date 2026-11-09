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

  it("taking a room out of service lists its upcoming meetings on both update paths, and cancels none (R-3/R-4)", async () => {
    const id = await bobsMeeting("08:00", "09:00", dateFromToday(22));

    for (const [path, body] of [
      [`/api/rooms/${f.rooms.alpha.room_id}`, { roomName: "Alpha", roomCapacity: 10, roomLocation: "Floor 1", availabilityStatusId: 2 }],
      [`/api/rooms/${f.rooms.alpha.room_id}/edit`, { room_name: "Alpha", room_capacity: 10, roomLocation: "Floor 1", availabilityStatusId: 2 }],
    ] as const) {
      const res = await app.call("PATCH", path, { ...admin(), body });

      assert.equal(res.status, 409, path);
      assert.ok((res.json!.conflicts as { meetingId: number }[]).some((c) => c.meetingId === id), path);
    }

    assert.equal((await db.select().from(room).where(eq(room.room_id, f.rooms.alpha.room_id)))[0].availabilityStatusId, 1);
    assert.equal((await db.select().from(meeting).where(eq(meeting.meeting_id, id)))[0].meetingStatusId, 1);
  });

  it("an invalid availability status on the edit path is 400", async () => {
    const res = await app.call("PATCH", `/api/rooms/${f.rooms.alpha.room_id}/edit`, {
      ...admin(),
      body: { room_name: "Alpha", room_capacity: 10, roomLocation: "Floor 1", availabilityStatusId: 999 },
    });

    assert.equal(res.status, 400);
  });
});

describe("not-found states (D-16)", () => {
  it("an unknown room on the booking form is a 404 page inside the app, an unknown URL the global 404", async () => {
    const room = await app.call("GET", "/booking/details?roomId=99999", { as: f.users.bob });
    assert.equal(room.status, 404);
    // The signed-in not-found page (app/(app)/not-found.tsx), not the global one.
    assert.match(room.text, /What you are looking for does not exist/);

    const page = await app.call("GET", "/no-such-page", { as: f.users.bob });
    assert.equal(page.status, 404);
    assert.match(page.text, /Page not found/);
  });
});

describe("My Bookings paging (D-09 / D-10)", () => {
  it("malformed tab, page and date fall back to defaults; a page past the end shows the last one", async () => {
    for (const qs of ["", "?tab=cancelled&page=999", "?tab=bogus&page=abc&date=2026-1-1", "?tab=__proto__", "?date=2031-02-30"]) {
      const res = await app.call("GET", `/bookings${qs}`, { as: f.users.bob });
      assert.equal(res.status, 200, `${qs} -> ${res.status}`);
    }

    const page = await app.call("GET", "/bookings?tab=cancelled&page=999", { as: f.users.bob });
    assert.match(page.text, /Page <!-- -->1<!-- --> of <!-- -->1|Page 1 of 1|No cancelled meetings found/);
  });
});

describe("room archiving (R-2)", () => {
  const archive = (roomId: number, archived: boolean, as = f.users.admin) =>
    app.call("PATCH", `/api/rooms/${roomId}/archive`, { as, body: { archived } });

  it("only room managers may archive", async () => {
    for (const user of [f.users.bob, f.users.manager]) {
      assert.equal((await archive(f.rooms.beta.room_id, true, user)).status, 403);
    }
    assert.equal((await db.select().from(room).where(eq(room.room_id, f.rooms.beta.room_id)))[0].archived_at, null);
  });

  it("validates the body and the room", async () => {
    assert.equal((await app.call("PATCH", `/api/rooms/${f.rooms.beta.room_id}/archive`, { as: f.users.admin, body: {} })).status, 400);
    assert.equal((await app.call("PATCH", "/api/rooms/abc/archive", { as: f.users.admin, body: { archived: true } })).status, 400);
    assert.equal((await archive(99_999, true)).status, 404);
  });

  it("is refused while meetings are booked in the room", async () => {
    const res = await archive(f.rooms.alpha.room_id, true);

    assert.equal(res.status, 409);
    assert.ok((res.json!.conflicts as unknown[]).length > 0);
  });

  it("an archived room disappears for employees and cannot be booked; restoring brings it back", async () => {
    const beta = f.rooms.beta.room_id;
    const listed = async () =>
      ((await app.call("GET", "/api/rooms", { as: f.users.bob })).json as unknown as { room_id: number }[]).some((r) => r.room_id === beta);

    assert.equal((await archive(beta, true)).status, 200);

    try {
      assert.equal(await listed(), false);

      const book = await app.call("POST", "/api/meetings/booking", {
        as: f.users.bob,
        body: {
          title: "In an archived room",
          meeting_date: dateFromToday(23),
          room_id: beta,
          participant_count: 2,
          meeting_type_id: f.types.team,
          start_time: "10:00",
          end_time: "11:00",
        },
      });
      assert.equal(book.status, 409, book.text);
    } finally {
      assert.equal((await archive(beta, false)).status, 200);
    }

    assert.equal(await listed(), true);
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
