import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, reschedule_requests, room } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  type BookingInput,
} from "@/lib/services/booking.service";
import { deliverNotification } from "@/lib/services/notification.service";
import {
  bumpDeadline,
  getClaimableRooms,
  processExpiredBumps,
} from "@/lib/services/priority.service";
import {
  rescheduleMeeting,
  RescheduleError,
} from "@/lib/services/reschedule.service";

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
    TRUNCATE meeting_audit_logs, reminder_logs, notifications,
      reschedule_requests, meeting_attendees, meeting, recurring_meetings
    RESTART IDENTITY CASCADE
  `);
  await db
    .update(room)
    .set({ availabilityStatusId: 1 })
    .where(eq(room.room_id, f.rooms.alpha.room_id));
});

const DAY = () => dateFromToday(7);

// Alpha, 10:00-11:00, booked as the employee's team meeting unless overridden.
function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Team sync",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [DAY()],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 2,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [f.users.carol.employeeId],
    notify: false,
    ...overrides,
  };
}

// The higher-priority booking: a manager's interview in the same slot.
function interview(overrides: Partial<BookingInput> = {}): BookingInput {
  return input({
    title: "Candidate interview",
    organizerEmployeeId: f.users.manager.employeeId,
    organizerRole: "Manager",
    meetingTypeId: f.types.interview,
    participantEmployeeIds: [],
    participantCount: 1,
    ...overrides,
  });
}

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

describe("priority-based booking", () => {
  it("gives the room to the higher-priority meeting and leaves the other pending, with an e-mail to its organizer only", async () => {
    const { meetings: [low] } = await createBooking(input());

    const result = await createBooking(interview());

    const bumped = await meetingById(low.meeting_id);
    assert.equal(bumped.meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);
    assert.equal(bumped.room_id, f.rooms.alpha.room_id, "room and time stay on record");

    const claimant = await meetingById(result.meetings[0].meeting_id);
    assert.equal(claimant.room_id, f.rooms.alpha.room_id);
    assert.equal(claimant.meetingStatusId, MEETING_STATUS.SCHEDULED);

    const [request] = await db.select().from(reschedule_requests);
    assert.equal(request.status, "PENDING");
    assert.equal(request.bumped_meeting_id, low.meeting_id);
    assert.equal(request.claimant_meeting_id, claimant.meeting_id);
    assert.equal(
      request.deadline.getTime(),
      bumpDeadline(DAY(), "10:00").getTime(),
      "30 minutes before the meeting starts"
    );

    assert.equal(result.otherNotificationIds.length, 1);
    assert.equal(await deliverNotification(result.otherNotificationIds[0]), "SENT");

    const [m] = mail.sent;
    assert.equal(m.to, f.users.bob.email, "only the organizer is asked to act");
    assert.match(m.subject, /Action Required/);
    assert.match(
      m.text,
      /required for a high-priority meeting: Interview organized by Mona Manager/
    );
    assert.match(m.text, /change the room or time/);
    assert.match(m.text, /cancelled automatically/);
    assert.match(m.text, /If it is not changed by \d{4}-\d{2}-\d{2} 09:30/);
    assert.equal(m.ics, "", "no invite for a slot the meeting no longer holds");
  });

  it("cancels the bumped meeting at once when it starts within the response window", async () => {
    const { meetings: [low] } = await createBooking(input());

    // 09:40 on the day: 20 minutes before the 10:00 start, past the 09:30 cutoff.
    const result = await createBooking(
      interview({ now: new Date(bumpDeadline(DAY(), "10:00").getTime() + 10 * 60_000) })
    );

    assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.CANCELLED);

    const [request] = await db.select().from(reschedule_requests);
    assert.equal(request.status, "AUTO_CANCELLED");

    await deliverNotification(result.otherNotificationIds[0]);

    const [m] = mail.sent;
    assert.match(m.subject, /Meeting Cancelled/);
    assert.match(m.text, /Interview organized by Mona Manager/);
    assert.match(m.text, /Please book another available slot/);
    assert.equal(m.ics, "", "no invite for a cancelled meeting");
  });

  describe("waiting for the organizer", () => {
    async function bump() {
      const { meetings: [low] } = await createBooking(input());
      await createBooking(interview());
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
      const id = await bump();

      assert.equal(await processExpiredBumps(new Date(deadline().getTime() - 60_000)), 0);
      assert.equal((await meetingById(id)).meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);

      assert.equal(await processExpiredBumps(new Date(deadline().getTime() + 60_000)), 1);
      assert.equal((await meetingById(id)).meetingStatusId, MEETING_STATUS.CANCELLED);

      const [request] = await db.select().from(reschedule_requests);
      assert.equal(request.status, "AUTO_CANCELLED");
      assert.ok(request.resolved_at);

      await mailArrived(1);
      const [m] = mail.sent;
      assert.match(m.subject, /Meeting Cancelled/);
      assert.ok(m.to.includes(f.users.bob.email) && m.to.includes(f.users.carol.email));
      assert.match(m.text, /not changed in time/);

      assert.equal(
        await processExpiredBumps(new Date(deadline().getTime() + 120_000)),
        0,
        "never cancelled (or mailed) twice"
      );
    });

    it("can be moved to another room, which keeps it and tells everyone", async () => {
      const id = await bump();

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

      const [request] = await db.select().from(reschedule_requests);
      assert.equal(request.status, "RESCHEDULED");

      const [m] = mail.sent;
      assert.match(m.subject, /Meeting Updated/);
      assert.ok(m.to.includes(f.users.bob.email) && m.to.includes(f.users.carol.email));

      assert.equal(await processExpiredBumps(new Date(deadline().getTime() + 60_000)), 0);
      assert.equal((await meetingById(id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    });

    it("can be moved to another time in the same room", async () => {
      const id = await bump();

      await rescheduleMeeting({
        meetingId: id,
        actor: { employeeId: f.users.bob.employeeId, role: "Employee" },
        roomId: f.rooms.alpha.room_id,
        meetingDate: DAY(),
        startTime: "11:00",
        endTime: "12:00",
        notify: false,
      });

      const moved = await meetingById(id);
      assert.equal(moved.meetingStatusId, MEETING_STATUS.SCHEDULED);
      assert.equal(moved.start_time.slice(0, 5), "11:00");
    });

    it("cannot be moved onto the slot that took its place, or by someone else", async () => {
      const id = await bump();
      const move = (employeeId: number, role: string) =>
        rescheduleMeeting({
          meetingId: id,
          actor: { employeeId, role },
          roomId: f.rooms.alpha.room_id,
          meetingDate: DAY(),
          startTime: "10:00",
          endTime: "11:00",
          notify: false,
        });

      await assert.rejects(move(f.users.bob.employeeId, "Employee"), (e: unknown) => {
        assert.ok(e instanceof RescheduleError);
        assert.equal(e.status, 409);
        return true;
      });

      await assert.rejects(move(f.users.carol.employeeId, "Employee"), (e: unknown) => {
        assert.ok(e instanceof RescheduleError);
        assert.equal(e.status, 403);
        return true;
      });

      assert.equal((await meetingById(id)).meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);
    });

    it("does not hold the room, so the slot is not reported as taken", async () => {
      await bump();
      // Only the interview holds Alpha 10:00-11:00 now.
      const holders = await db.execute(
        sql`SELECT count(*)::int AS n FROM meeting WHERE room_id = ${f.rooms.alpha.room_id} AND meeting_status_id NOT IN (3, 4)`
      );
      assert.equal((holders.rows[0] as { n: number }).n, 1);
    });
  });

  it("never bumps a meeting of equal priority", async () => {
    await createBooking(input());

    const error = await rejection(
      createBooking(
        input({
          title: "Other team sync",
          organizerEmployeeId: f.users.carol.employeeId,
          participantEmployeeIds: [],
          participantCount: 1,
        })
      )
    );

    assert.equal(error.status, 409);
    assert.equal((await db.select().from(reschedule_requests)).length, 0);
  });

  it("never bumps a higher-priority meeting", async () => {
    const { meetings: [high] } = await createBooking(interview());

    const error = await rejection(createBooking(input()));

    assert.equal(error.status, 409);
    assert.equal((await meetingById(high.meeting_id)).room_id, f.rooms.alpha.room_id);
  });

  it("does not bump anything when one of the meetings in the way outranks the request", async () => {
    // 10:00-10:30 low priority, 10:30-11:00 top priority.
    const { meetings: [low] } = await createBooking(input({ endTime: "10:30" }));
    await createBooking(
      input({
        startTime: "10:30",
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
        participantEmployeeIds: [],
        participantCount: 1,
      })
    );

    const error = await rejection(createBooking(interview()));

    assert.equal(error.status, 409);
    const untouched = await meetingById(low.meeting_id);
    assert.equal(untouched.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(untouched.room_id, f.rooms.alpha.room_id);
  });

  describe("role boost", () => {
    // Manager boost is 1: a team meeting (3) counts as rank 2.
    const managerTeam = (overrides: Partial<BookingInput> = {}) =>
      input({
        title: "Manager team sync",
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        participantEmployeeIds: [],
        participantCount: 1,
        ...overrides,
      });

    it("lets a manager's meeting bump an employee's meeting of the same type", async () => {
      const { meetings: [low] } = await createBooking(input());

      await createBooking(managerTeam());

      assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);
      assert.equal((await db.select().from(reschedule_requests)).length, 1);
    });

    it("counts a manager who is only an attendee", async () => {
      const { meetings: [low] } = await createBooking(input());

      await createBooking(
        input({
          title: "Bob's sync with Mona",
          organizerEmployeeId: f.users.carol.employeeId,
          participantEmployeeIds: [f.users.manager.employeeId],
          participantCount: 2,
        })
      );

      assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);
    });

    it("does not let a boosted meeting bump a manager's meeting of the same boosted rank", async () => {
      await createBooking(managerTeam());

      const error = await rejection(createBooking(managerTeam({ title: "Another" })));

      assert.equal(error.status, 409);
    });

    it("lets a manager's meeting bump another team's client meeting, whatever its own type", async () => {
      const { meetings: [client] } = await createBooking(
        input({
          title: "Client call",
          organizerEmployeeId: f.users.bob.employeeId,
          meetingTypeId: f.types.client,
          organizerRole: "Team Lead",
          participantEmployeeIds: [],
          participantCount: 1,
        })
      );

      await createBooking(managerTeam({ title: "Late" }));

      assert.equal((await meetingById(client.meeting_id)).meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);
    });

    it("never bumps a manager's meeting for a non-manager's client meeting", async () => {
      const { meetings: [mine] } = await createBooking(managerTeam());

      const error = await rejection(
        createBooking(
          input({
            title: "Client call",
            organizerEmployeeId: f.users.bob.employeeId,
            organizerRole: "Team Lead",
            meetingTypeId: f.types.client,
            participantEmployeeIds: [],
            participantCount: 1,
          })
        )
      );

      assert.equal(error.status, 409);
      assert.equal((await meetingById(mine.meeting_id)).room_id, f.rooms.alpha.room_id);
    });

    it("orders two manager meetings by type", async () => {
      await createBooking(managerTeam());

      const error = await rejection(
        createBooking(managerTeam({ title: "Another", meetingTypeId: f.types.training }))
      );
      assert.equal(error.status, 409);

      await createBooking(managerTeam({ title: "Interview", meetingTypeId: f.types.interview }));
    });

    it("applies the boost when listing claimable rooms", async () => {
      // Held by a team meeting; the manager's best type is boosted to rank 1.
      await createBooking(input());
      assert.equal(
        (await getClaimableRooms("Manager", DAY(), "10:00", "11:00", 1)).length,
        1
      );
    });
  });

  it("lists rooms a role could claim, but not rooms held by equal or higher priority", async () => {
    await createBooking(input());

    const manager = await getClaimableRooms("Manager", DAY(), "10:00", "11:00", 1);
    assert.deepEqual(
      manager.map((r) => r.room_id),
      [f.rooms.alpha.room_id]
    );

    // An Employee's best type (Team Meeting) is the same rank as the holder.
    assert.deepEqual(await getClaimableRooms("Employee", DAY(), "10:00", "11:00", 1), []);
  });
});
