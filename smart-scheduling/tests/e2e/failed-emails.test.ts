import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { notifications } from "@/db/schema";
import { createBooking } from "@/lib/services/booking.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { startApp, type App } from "./harness";

// N8: administrators can see e-mails that were given up on, and requeue them.

let app: App;
let f: Fixtures;
let failedId: number;

before(async () => {
  f = await seedFixtures();

  const booking = await createBooking({
    title: "Quarterly review",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [dateFromToday(9)],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 1,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [],
    notify: false,
  });

  failedId = booking.notificationId;

  await db
    .update(notifications)
    .set({ status: "FAILED", attempts: 5, last_error: "SMTP 550: rejected" })
    .where(eq(notifications.notification_id, failedId));

  app = await startApp(3200);
});

after(() => app?.stop());

describe("failed e-mails for administrators (N8)", () => {
  it("are listed for the Admin role, with the reason", async () => {
    const res = await app.call("GET", "/api/admin/notifications", { as: f.users.admin });

    assert.equal(res.status, 200, res.text);

    const body = JSON.parse(res.text) as {
      failed: { kind: string; id: number; meetingTitle: string; lastError: string }[];
    };
    const row = body.failed.find((x) => x.kind === "notification" && x.id === failedId);

    assert.ok(row);
    assert.equal(row.meetingTitle, "Quarterly review");
    assert.equal(row.lastError, "SMTP 550: rejected");
  });

  it("are not visible to anyone else", async () => {
    for (const user of [f.users.bob, f.users.manager]) {
      const res = await app.call("GET", "/api/admin/notifications", { as: user });
      assert.equal(res.status, 403);
    }

    assert.equal((await app.call("GET", "/api/admin/notifications")).status, 401);
  });

  it("can be requeued by an administrator only", async () => {
    const denied = await app.call("POST", "/api/admin/notifications/retry", {
      as: f.users.bob,
      body: { kind: "notification", id: failedId },
    });
    assert.equal(denied.status, 403);

    const ok = await app.call("POST", "/api/admin/notifications/retry", {
      as: f.users.admin,
      body: { kind: "notification", id: failedId },
    });
    assert.equal(ok.status, 200, ok.text);

    const [row] = await db.select().from(notifications).where(eq(notifications.notification_id, failedId));
    assert.equal(row.attempts, 0);
    assert.notEqual(row.status, "FAILED");

    const again = await app.call("POST", "/api/admin/notifications/retry", {
      as: f.users.admin,
      body: { kind: "notification", id: failedId },
    });
    assert.equal(again.status, 404);

    const bad = await app.call("POST", "/api/admin/notifications/retry", {
      as: f.users.admin,
      body: { kind: "everything", id: failedId },
    });
    assert.equal(bad.status, 400);
  });
});
