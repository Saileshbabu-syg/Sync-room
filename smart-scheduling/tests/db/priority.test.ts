import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { DEFAULT_GROUPS } from "@/db/seed-groups";
import {
  bookingPriorityHistory,
  employee,
  groupPermissions,
  groups,
  meeting,
  meeting_audit_logs,
  reschedule_requests,
  roles,
  room,
  userGroups,
} from "@/db/schema";
import { MEETING_STATUS, PERMISSION } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  type BookingInput,
} from "@/lib/services/booking.service";
import { updateGroup } from "@/lib/services/group.service";
import { deliverNotification } from "@/lib/services/notification.service";
import {
  bumpDeadline,
  canBumpAll,
  getClaimableRooms,
  processExpiredBumps,
  type SlotHolder,
} from "@/lib/services/priority.service";
import {
  rescheduleMeeting,
  RescheduleError,
} from "@/lib/services/reschedule.service";
import { appWallClockToUtc } from "@/lib/time";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

before(async () => {
  f = await seedFixtures();
  mail = captureMail();
});

after(() => mail?.restore());

beforeEach(async () => {
  mail.sent.length = 0;
  await db.execute(sql`
    TRUNCATE booking_priority_history, group_audit_logs, meeting_audit_logs,
      reminder_logs, notifications, reschedule_requests, meeting_attendees,
      meeting, recurring_meetings
    RESTART IDENTITY CASCADE
  `);
  await db
    .update(room)
    .set({ availabilityStatusId: 1 })
    .where(eq(room.room_id, f.rooms.alpha.room_id));

  // Tests edit groups and permissions; start each one from the defaults.
  for (const g of DEFAULT_GROUPS) {
    await db
      .update(groups)
      .set({ priority: g.priority, isActive: true })
      .where(eq(groups.name, g.name));
  }

  await db.execute(sql`
    UPDATE group_permissions gp SET is_enabled =
      (gp.permission_key <> 'dashboard.view' OR g.name IN ('HR', 'Admin'))
    FROM groups g WHERE g.id = gp.group_id
  `);
});

const DAY = () => dateFromToday(7);

// Extra employees placed in a group (null = no group).
async function addUser(name: string, groupId: number | null) {
  const [role] = await db.select().from(roles).where(eq(roles.roleName, "Employee"));
  const [emp] = await db
    .insert(employee)
    .values({
      role_id: role.roleId,
      employee_name: name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`,
    })
    .returning();

  if (groupId !== null) {
    await db.insert(userGroups).values({ employeeId: emp.employee_id, groupId });
  }

  return emp.employee_id;
}

// Alpha, 10:00-11:00, booked by Bob (Employee group, priority 5) unless overridden.
function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Team sync",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [DAY()],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    // The role only decides which meeting types are allowed; priority comes
    // from the organizer's group.
    organizerRole: "Manager",
    participantCount: 1,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [],
    notify: false,
    ...overrides,
  };
}

// Mona (Manager group, priority 3) wants the same slot.
const byManager = (overrides: Partial<BookingInput> = {}) =>
  input({
    title: "Manager meeting",
    organizerEmployeeId: f.users.manager.employeeId,
    ...overrides,
  });

async function rejection(promise: Promise<unknown>): Promise<BookingError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BookingError, `expected BookingError, got ${error}`);
    return error;
  }

  assert.fail("expected the booking to be rejected");
}

async function meetingById(id: number) {
  const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, id));
  return row;
}

const history = () => db.select().from(bookingPriorityHistory);

// Wall-clock `time` on `date` in the app timezone, as an instant.
function at(date: string, time: string) {
  const [y, mo, d, h, mi] = appWallClockToUtc(date, time);

  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

describe("group-based booking priority", () => {
  it("preempts a lower-priority booking, records it, and e-mails both sides", async () => {
    const { meetings: [low] } = await createBooking(
      input({ participantCount: 2, participantEmployeeIds: [f.users.carol.employeeId] })
    );

    const result = await createBooking(byManager());

    const preempted = await meetingById(low.meeting_id);
    assert.equal(preempted.meetingStatusId, MEETING_STATUS.PREEMPTED);
    assert.equal(preempted.room_id, f.rooms.alpha.room_id, "original details stay on record");
    assert.equal(preempted.start_time.slice(0, 5), "10:00");

    const winner = await meetingById(result.meetings[0].meeting_id);
    assert.equal(winner.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(winner.groupIdAtBooking, f.groupIds.manager);
    assert.equal(winner.priorityAtBooking, 3);

    const [row] = await history();
    assert.equal(row.incomingBookingId, winner.meeting_id);
    assert.equal(row.affectedBookingId, low.meeting_id);
    assert.equal(row.previousGroupId, f.groupIds.employee);
    assert.equal(row.previousPriority, 5);
    assert.equal(row.incomingGroupId, f.groupIds.manager);
    assert.equal(row.incomingPriority, 3);
    assert.equal(row.actorEmployeeId, f.users.manager.employeeId);
    assert.match(row.reason, /Preempted by Manager booking/);

    const audit = await db
      .select()
      .from(meeting_audit_logs)
      .where(eq(meeting_audit_logs.meeting_id, low.meeting_id));
    assert.ok(audit.some((a) => a.action === "MEETING_PREEMPTED"));

    // Preempted side: every attendee. Winning side: the normal confirmation.
    assert.equal(result.otherNotificationIds.length, 1);
    assert.equal(await deliverNotification(result.otherNotificationIds[0]), "SENT");
    assert.equal(await deliverNotification(result.notificationId), "SENT");

    const preemptedMail = mail.sent.find((m) => /Preempted/.test(m.subject))!;
    assert.ok(preemptedMail.to.includes(f.users.bob.email));
    assert.ok(preemptedMail.to.includes(f.users.carol.email));
    assert.match(preemptedMail.text, /priority 3/);
    assert.equal(preemptedMail.ics, "", "no invite for a slot the meeting no longer holds");

    const confirmation = mail.sent.find((m) => /Scheduled/.test(m.subject))!;
    assert.ok(confirmation.to.includes(f.users.manager.email));
  });

  it("lets Leadership (priority 1) take the room of an Employee (priority 5)", async () => {
    const lead = await addUser("Lena Lead", f.groupIds.leadership);
    const { meetings: [low] } = await createBooking(input());

    const result = await createBooking(input({ organizerEmployeeId: lead }));

    assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    assert.equal((await meetingById(result.meetings[0].meeting_id)).priorityAtBooking, 1);
  });

  it("never lets a lower-priority group take a higher-priority booking", async () => {
    const { meetings: [high] } = await createBooking(byManager());

    const error = await rejection(createBooking(input()));

    assert.equal(error.status, 409);
    assert.equal((await meetingById(high.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal((await history()).length, 0);
  });

  it("keeps first-confirmed-wins between equal priorities", async () => {
    const { meetings: [first] } = await createBooking(input());

    const error = await rejection(
      createBooking(input({ organizerEmployeeId: f.users.carol.employeeId }))
    );

    assert.equal(error.status, 409);
    assert.equal((await meetingById(first.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("cannot preempt a meeting that has already started", async () => {
    const today = dateFromToday(0);
    // 10:05 on the day: Bob's 10:00 meeting is under way, Mona asks for 10:15.
    const { meetings: [started] } = await createBooking(
      input({ occurrenceDates: [today], now: at(today, "09:00") })
    );

    const error = await rejection(
      createBooking(
        byManager({
          occurrenceDates: [today],
          startTime: "10:15",
          endTime: "10:45",
          now: at(today, "10:05"),
        })
      )
    );

    assert.equal(error.status, 409);
    assert.equal((await meetingById(started.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("preempts every conflicting booking at once", async () => {
    const { meetings: [a] } = await createBooking(input({ endTime: "10:30" }));
    const { meetings: [b] } = await createBooking(
      input({ startTime: "10:30", organizerEmployeeId: f.users.carol.employeeId })
    );

    const result = await createBooking(byManager());

    assert.equal((await meetingById(a.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    assert.equal((await meetingById(b.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    assert.equal((await history()).length, 2);
    assert.equal(result.otherNotificationIds.length, 2);
  });

  it("detects partial overlaps but not back-to-back meetings", async () => {
    const { meetings: [low] } = await createBooking(input());

    // Starts exactly when the other ends: no conflict, nothing preempted.
    await createBooking(byManager({ startTime: "11:00", endTime: "12:00" }));
    assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal((await history()).length, 0);

    // Overlaps the last half hour.
    await createBooking(byManager({ title: "Late", startTime: "10:30", endTime: "10:45" }));
    assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
  });

  it("ignores cancelled bookings", async () => {
    const { meetings: [cancelled] } = await createBooking(input());
    await db
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.CANCELLED })
      .where(eq(meeting.meeting_id, cancelled.meeting_id));

    // Even an equal-priority user may take the slot, and nothing is preempted.
    await createBooking(input({ organizerEmployeeId: f.users.carol.employeeId }));

    assert.equal((await meetingById(cancelled.meeting_id)).meetingStatusId, MEETING_STATUS.CANCELLED);
    assert.equal((await history()).length, 0);
  });

  it("changes nothing when one of the conflicts outranks the request", async () => {
    // Bob (P5) 10:00-10:30, another Manager (P3) 10:30-11:00; Mona (P3) wants both.
    const other = await addUser("Max Manager", f.groupIds.manager);
    const { meetings: [low] } = await createBooking(input({ endTime: "10:30" }));
    await createBooking(input({ startTime: "10:30", organizerEmployeeId: other }));

    const error = await rejection(createBooking(byManager()));

    assert.equal(error.status, 409);
    assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal((await history()).length, 0);
  });

  it("stores the group and priority used and never rewrites them later", async () => {
    const { meetings: [m] } = await createBooking(input());
    assert.equal(m.groupIdAtBooking, f.groupIds.employee);
    assert.equal(m.priorityAtBooking, 5);

    await updateGroup(f.groupIds.employee, { priority: 1 }, f.users.admin.employeeId);
    await updateGroup(f.groupIds.leadership, { priority: 7 }, f.users.admin.employeeId);

    const after = await meetingById(m.meeting_id);
    assert.equal(after.priorityAtBooking, 5, "the snapshot is history, not a live value");
    assert.equal(after.groupIdAtBooking, f.groupIds.employee);

    // New bookings use the new priority.
    const [fresh] = (await createBooking(input({ startTime: "12:00", endTime: "13:00" }))).meetings;
    const [current] = await db.select().from(groups).where(eq(groups.id, f.groupIds.employee));
    assert.equal(fresh.priorityAtBooking, current.priority);
  });

  it("compares a holder on its stored priority, not its group's current one", async () => {
    const { meetings: [low] } = await createBooking(input());

    // Employee group becomes the top group afterwards.
    await db.update(groups).set({ priority: 1 }).where(eq(groups.id, f.groupIds.employee));

    // Mona (still P3) outranks Bob's booking, which was made at P5.
    await createBooking(byManager());

    assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    assert.equal((await history())[0].previousPriority, 5);
  });

  describe("employees without a usable group", () => {
    it("rank as the lowest active group and never preempt", async () => {
      const dave = f.users.dave.employeeId;
      const { meetings: [mine] } = await createBooking(input({ organizerEmployeeId: dave }));

      assert.equal(mine.groupIdAtBooking, null);
      assert.equal(mine.priorityAtBooking, 5, "lowest active priority, not the highest");

      // A Manager takes the slot from them.
      await createBooking(byManager());
      assert.equal((await meetingById(mine.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);

      // And they cannot take it back, nor preempt an equal-priority booking.
      assert.equal((await rejection(createBooking(input({ organizerEmployeeId: dave })))).status, 409);
    });

    it("are treated like that when their group is deactivated", async () => {
      await db.update(groups).set({ isActive: false }).where(eq(groups.id, f.groupIds.manager));

      const { meetings: [m] } = await createBooking(byManager({ startTime: "14:00", endTime: "15:00" }));

      assert.equal(m.groupIdAtBooking, null);
    });
  });

  describe("permissions", () => {
    it("refuses a booking from a group without booking.create", async () => {
      await db
        .update(groupPermissions)
        .set({ isEnabled: false })
        .where(eq(groupPermissions.permissionKey, PERMISSION.BOOKING_CREATE));

      const error = await rejection(createBooking(input()));

      assert.equal(error.status, 403);
      assert.equal((await db.select().from(meeting)).length, 0);
    });

    it("does not preempt without booking.priority, whatever the priority number", async () => {
      await createBooking(input());

      await db
        .update(groupPermissions)
        .set({ isEnabled: false })
        .where(eq(groupPermissions.permissionKey, PERMISSION.BOOKING_PRIORITY));

      const error = await rejection(createBooking(byManager()));

      assert.equal(error.status, 409);
      assert.equal((await history()).length, 0);
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two equal-priority requests have the slot", async () => {
      const results = await Promise.allSettled([
        createBooking(input()),
        createBooking(input({ organizerEmployeeId: f.users.carol.employeeId })),
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

      const holders = await db.execute(
        sql`SELECT count(*)::int AS n FROM meeting WHERE room_id = ${f.rooms.alpha.room_id} AND meeting_status_id NOT IN (3, 4, 6)`
      );
      assert.equal((holders.rows[0] as { n: number }).n, 1);
    });

    it("ends with the highest-priority request holding the slot, never two holders", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);

      await Promise.allSettled([
        createBooking(input()),
        createBooking(byManager()),
        createBooking(input({ organizerEmployeeId: lead, title: "Leadership" })),
      ]);

      const holders = await db
        .select()
        .from(meeting)
        .where(sql`${meeting.room_id} = ${f.rooms.alpha.room_id} AND ${meeting.meetingStatusId} NOT IN (3, 4, 6)`);

      assert.equal(holders.length, 1);
      assert.equal(holders[0].title, "Leadership");
    });
  });

  describe("claimable rooms", () => {
    it("lists a room whose bookings the employee's group could preempt", async () => {
      await createBooking(input());

      const rooms = await getClaimableRooms(f.users.manager.employeeId, DAY(), "10:00", "11:00", 1);
      assert.deepEqual(rooms.map((r) => r.room_id), [f.rooms.alpha.room_id]);

      // Equal priority, or no permission to preempt: nothing to claim.
      assert.deepEqual(
        await getClaimableRooms(f.users.carol.employeeId, DAY(), "10:00", "11:00", 1),
        []
      );
      assert.deepEqual(
        await getClaimableRooms(f.users.dave.employeeId, DAY(), "10:00", "11:00", 1),
        []
      );
    });
  });
});

describe("canBumpAll (pure rule)", () => {
  const holder = (priority: number, startTime = "10:00"): SlotHolder => ({
    meetingId: 1,
    title: "t",
    roomId: 1,
    meetingDate: "2999-01-01",
    startTime,
    endTime: "11:00",
    participantCount: 1,
    organizerEmployeeId: 1,
    groupId: null,
    priority,
  });

  it("requires a strictly lower priority for every holder and the permission", () => {
    assert.equal(canBumpAll([holder(5)], { priority: 3, canPreempt: true }), true);
    assert.equal(canBumpAll([holder(3)], { priority: 3, canPreempt: true }), false);
    assert.equal(canBumpAll([holder(2)], { priority: 3, canPreempt: true }), false);
    assert.equal(canBumpAll([holder(5), holder(2)], { priority: 3, canPreempt: true }), false);
    assert.equal(canBumpAll([holder(5)], { priority: 1, canPreempt: false }), false);
    assert.equal(canBumpAll([], { priority: 9, canPreempt: false }), true);
  });
});

// Meetings the earlier meeting-type engine left waiting for their organizer
// (status PENDING_RESCHEDULE) are still handled by the reschedule flow.
describe("legacy meetings waiting to be rescheduled", () => {
  // Recreates the state the old engine produced: Bob's meeting parked, a
  // claimant meeting now holding its slot.
  async function parked() {
    const { meetings: [low] } = await createBooking(
      input({ participantCount: 2, participantEmployeeIds: [f.users.carol.employeeId] })
    );

    await db
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.PENDING_RESCHEDULE })
      .where(eq(meeting.meeting_id, low.meeting_id));

    const { meetings: [claimant] } = await createBooking(byManager());

    await db.insert(reschedule_requests).values({
      bumped_meeting_id: low.meeting_id,
      claimant_meeting_id: claimant.meeting_id,
      status: "PENDING",
      deadline: bumpDeadline(DAY(), "10:00"),
    });

    return low.meeting_id;
  }

  const deadline = () => bumpDeadline(DAY(), "10:00");

  // Dispatch after the cron job commits is fire-and-forget.
  async function mailArrived(count: number) {
    for (let i = 0; i < 50 && mail.sent.length < count; i++) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(mail.sent.length, count);
  }

  it("is left alone until 30 minutes before the meeting, then cancelled with an e-mail to everyone", async () => {
    const id = await parked();

    assert.equal(await processExpiredBumps(new Date(deadline().getTime() - 60_000)), 0);
    assert.equal((await meetingById(id)).meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);

    assert.equal(await processExpiredBumps(new Date(deadline().getTime() + 60_000)), 1);
    assert.equal((await meetingById(id)).meetingStatusId, MEETING_STATUS.CANCELLED);

    const [request] = await db.select().from(reschedule_requests);
    assert.equal(request.status, "AUTO_CANCELLED");

    await mailArrived(1);
    assert.match(mail.sent[0].subject, /Meeting Cancelled/);

    assert.equal(await processExpiredBumps(new Date(deadline().getTime() + 120_000)), 0);
  });

  it("can be moved to another room, which keeps it and tells everyone", async () => {
    const id = await parked();

    await rescheduleMeeting({
      meetingId: id,
      actor: { employeeId: f.users.bob.employeeId, role: "Employee" },
      roomId: f.rooms.beta.room_id,
      meetingDate: DAY(),
      startTime: "10:00",
      endTime: "11:00",
    });

    await mailArrived(1);
    const moved = await meetingById(id);
    assert.equal(moved.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(moved.room_id, f.rooms.beta.room_id);
    assert.match(mail.sent[0].subject, /Meeting Updated/);
  });

  it("cannot be moved onto the slot that took its place, or by someone else", async () => {
    const id = await parked();
    const move = (employeeId: number) =>
      rescheduleMeeting({
        meetingId: id,
        actor: { employeeId, role: "Employee" },
        roomId: f.rooms.alpha.room_id,
        meetingDate: DAY(),
        startTime: "10:00",
        endTime: "11:00",
        notify: false,
      });

    await assert.rejects(move(f.users.bob.employeeId), (e: unknown) => {
      assert.ok(e instanceof RescheduleError);
      assert.equal(e.status, 409);
      return true;
    });

    await assert.rejects(move(f.users.carol.employeeId), (e: unknown) => {
      assert.ok(e instanceof RescheduleError);
      assert.equal(e.status, 403);
      return true;
    });
  });
});
