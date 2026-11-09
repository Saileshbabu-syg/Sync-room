import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { DEFAULT_GROUPS } from "@/db/seed-groups";
import {
  bookingPriorityHistory,
  employee,
  groupAuditLogs,
  groupPermissions,
  groups,
  meeting,
  meeting_audit_logs,
  meetingTypes,
  reschedule_requests,
  roles,
  room,
  userGroups,
} from "@/db/schema";
import { MEETING_STATUS, PERMISSION, PROTECTED_RANK, TOP_RANK } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  PROTECTED_SLOT_MESSAGE,
  SLOT_TAKEN_MESSAGE,
  type BookingInput,
} from "@/lib/services/booking.service";
import {
  createGroup,
  GroupError,
  updateGroup,
  updateMeetingTypePriority,
} from "@/lib/services/group.service";
import { updateMeetingTypeSchema } from "@/lib/validations/group.validator";
import { deliverNotification } from "@/lib/services/notification.service";
import {
  bumpDeadline,
  canBumpAll,
  claimantRank,
  getClaimableRooms,
  processExpiredBumps,
  type SlotHolder,
} from "@/lib/services/priority.service";
import {
  rescheduleMeeting,
  RescheduleError,
} from "@/lib/services/reschedule.service";
import { getRoomSchedule } from "@/lib/services/room-suggestion.service";
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
      AND (gp.permission_key NOT IN ('booking.outranks', 'booking.protected') OR g.name = 'Leadership')
    FROM groups g WHERE g.id = gp.group_id
  `);
});

const DAY = () => dateFromToday(7);

let userSequence = 0;

// Extra employees placed in a group (null = no group).
async function addUser(name: string, groupId: number | null) {
  const [role] = await db.select().from(roles).where(eq(roles.roleName, "Employee"));
  const [emp] = await db
    .insert(employee)
    .values({
      role_id: role.roleId,
      employee_name: name,
      // Employees survive between tests, so the e-mail must be unique per call.
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${++userSequence}@example.test`,
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
    // from the meeting type (here "Others", rank 5).
    organizerRole: "Manager",
    participantCount: 1,
    meetingTypeId: f.types.others,
    participantEmployeeIds: [],
    notify: false,
    ...overrides,
  };
}

// Mona wants the same slot for a Team Meeting (rank 3), which outranks "Others".
const byManager = (overrides: Partial<BookingInput> = {}) =>
  input({
    title: "Manager meeting",
    organizerEmployeeId: f.users.manager.employeeId,
    meetingTypeId: f.types.team,
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

describe("meeting-type booking priority", () => {
  it("takes the room from a lower-priority meeting type, records it, and e-mails both sides", async () => {
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

    const [row] = await history();
    assert.equal(row.incomingBookingId, winner.meeting_id);
    assert.equal(row.affectedBookingId, low.meeting_id);
    assert.equal(row.previousPriority, 5, "Others");
    assert.equal(row.incomingPriority, 3, "Team Meeting");
    assert.equal(row.actorEmployeeId, f.users.manager.employeeId);
    assert.match(row.reason, /Preempted by .*meeting type priority 3 outranks 5/);

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
    // No invite for a slot the meeting no longer holds: a calendar CANCEL for
    // the entry the attendees already have (same UID) instead.
    assert.match(preemptedMail.ics, /METHOD:CANCEL/);
    assert.match(preemptedMail.ics, new RegExp(`UID:meeting-${low.meeting_id}@`));
    assert.match(preemptedMail.ics, /STATUS:CANCELLED/);
    assert.doesNotMatch(preemptedMail.ics, /METHOD:REQUEST/);

    const confirmation = mail.sent.find((m) => /Scheduled/.test(m.subject))!;
    assert.ok(confirmation.to.includes(f.users.manager.email));
  });

  it("applies to everyone alike: the meeting type decides, not the organizer's group", async () => {
    // Mona (Manager) holds the slot with a low-ranked type; Bob (Employee) takes
    // it with a higher-ranked one.
    const { meetings: [held] } = await createBooking(
      byManager({ meetingTypeId: f.types.others })
    );

    await createBooking(input({ meetingTypeId: f.types.team }));

    assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
  });

  it("never lets a lower-priority meeting type take a higher-priority booking", async () => {
    const { meetings: [high] } = await createBooking(byManager());

    const error = await rejection(createBooking(input()));

    assert.equal(error.status, 409);
    assert.equal((await meetingById(high.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal((await history()).length, 0);
  });

  it("keeps first-confirmed-wins between equal meeting types", async () => {
    const { meetings: [first] } = await createBooking(input());

    const error = await rejection(
      createBooking(input({ organizerEmployeeId: f.users.carol.employeeId }))
    );

    assert.equal(error.status, 409);
    assert.equal((await meetingById(first.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  describe("Leadership as a participant", () => {
    for (const optional of [false, true]) {
      it(`books regardless of meeting type when Leadership is an ${optional ? "optional" : "required"} participant`, async () => {
        const lead = await addUser("Lena Lead", f.groupIds.leadership);
        const { meetings: [held] } = await createBooking(byManager());

        // Carol's "Others" cannot touch Mona's Team Meeting on its own.
        const error = await rejection(
          createBooking(input({ organizerEmployeeId: f.users.carol.employeeId }))
        );
        assert.equal(error.status, 409);

        const result = await createBooking(
          input({
            organizerEmployeeId: f.users.carol.employeeId,
            participantCount: 2,
            participantEmployeeIds: optional ? [] : [lead],
            optionalParticipantEmployeeIds: optional ? [lead] : [],
          })
        );

        assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
        assert.equal(
          (await meetingById(result.meetings[0].meeting_id)).meetingStatusId,
          MEETING_STATUS.SCHEDULED
        );
        assert.equal((await history())[0].incomingPriority, 0);
      });
    }

    it("also applies when the organizer is in Leadership", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      const { meetings: [held] } = await createBooking(byManager({ meetingTypeId: f.types.client }));

      await createBooking(input({ organizerEmployeeId: lead }));

      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    });

    it("keeps the meeting protected from later bookings of any type", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      const { meetings: [protectedMeeting] } = await createBooking(
        input({ participantCount: 2, participantEmployeeIds: [lead] })
      );

      const error = await rejection(
        createBooking(byManager({ meetingTypeId: f.types.client }))
      );

      assert.equal(error.status, 409);
      assert.equal(
        (await meetingById(protectedMeeting.meeting_id)).meetingStatusId,
        MEETING_STATUS.SCHEDULED
      );
    });

    it("refuses a second meeting, even one that also invites Leadership, and says why", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      const other = await addUser("Leo Lead", f.groupIds.leadership);
      const { meetings: [first] } = await createBooking(
        input({ participantCount: 2, participantEmployeeIds: [lead] })
      );

      const error = await rejection(
        createBooking(byManager({ participantCount: 2, participantEmployeeIds: [other] }))
      );

      assert.equal(error.status, 409);
      assert.equal(error.message, PROTECTED_SLOT_MESSAGE);
      assert.equal((await meetingById(first.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
      assert.equal((await history()).length, 0);
    });

    it("refuses a plain 'room already booked' message when nothing in the way is protected", async () => {
      await createBooking(byManager({ meetingTypeId: f.types.client }));

      const error = await rejection(createBooking(input()));

      assert.equal(error.message, SLOT_TAKEN_MESSAGE);
    });

    it("cannot take a meeting that has already started", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      const today = dateFromToday(0);
      const { meetings: [started] } = await createBooking(
        input({ occurrenceDates: [today], now: at(today, "09:00") })
      );

      const error = await rejection(
        createBooking(
          input({
            occurrenceDates: [today],
            // At least 15 minutes ahead (B-09), still inside the 10:00 meeting.
            startTime: "10:20",
            endTime: "10:50",
            organizerEmployeeId: lead,
            now: at(today, "10:05"),
          })
        )
      );

      assert.equal(error.status, 409);
      assert.equal((await meetingById(started.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    });
  });

  describe("any group can outrank all meetings (booking.outranks)", () => {
    // A new group, switched on or off the way Group Management does it.
    async function board(permissions: string[]) {
      const group = await createGroup(
        {
          name: `Board ${++userSequence}`,
          description: null,
          priority: 6,
          isActive: true,
          permissions,
          meetingTypeIds: [],
          settings: { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: null },
          roomIds: [],
        } as never,
        f.users.admin.employeeId
      );

      return { groupId: group.id, member: await addUser("Bea Board", group.id) };
    }

    const base = [PERMISSION.BOOKING_CREATE, PERMISSION.BOOKING_VIEW];

    it("lets a meeting that invites a member of the new group take the room", async () => {
      const { member } = await board([...base, PERMISSION.BOOKING_OUTRANKS]);
      const { meetings: [held] } = await createBooking(byManager({ meetingTypeId: f.types.client }));

      await createBooking(input({ participantCount: 2, participantEmployeeIds: [member] }));

      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    });

    it("does nothing for a group without the permission", async () => {
      const { member } = await board(base);
      const { meetings: [held] } = await createBooking(byManager());

      const error = await rejection(
        createBooking(input({ participantCount: 2, participantEmployeeIds: [member] }))
      );

      assert.equal(error.status, 409);
      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    });

    it("stops working for Leadership when its permission is switched off", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      await db
        .update(groupPermissions)
        .set({ isEnabled: false })
        .where(
          sql`${groupPermissions.groupId} = ${f.groupIds.leadership} AND ${groupPermissions.permissionKey} = ${PERMISSION.BOOKING_OUTRANKS}`
        );
      await createBooking(byManager());

      const error = await rejection(
        createBooking(input({ participantCount: 2, participantEmployeeIds: [lead] }))
      );

      assert.equal(error.status, 409);
    });

    it("stops working when the group is deactivated", async () => {
      const { groupId, member } = await board([...base, PERMISSION.BOOKING_OUTRANKS]);
      await db.update(groups).set({ isActive: false }).where(eq(groups.id, groupId));
      await createBooking(byManager());

      const error = await rejection(
        createBooking(input({ participantCount: 2, participantEmployeeIds: [member] }))
      );

      assert.equal(error.status, 409);
    });

    it("outranking alone does not protect: a later, higher meeting type takes the room back", async () => {
      const { member } = await board([...base, PERMISSION.BOOKING_OUTRANKS]);
      const { meetings: [held] } = await createBooking(
        input({ participantCount: 2, participantEmployeeIds: [member] })
      );

      await createBooking(byManager());

      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    });
  });

  describe("protected meetings (booking.protected)", () => {
    const base = [PERMISSION.BOOKING_CREATE, PERMISSION.BOOKING_VIEW];

    async function boardWith(permissions: string[]) {
      const group = await createGroup(
        {
          name: `Guard ${++userSequence}`,
          description: null,
          priority: 6,
          isActive: true,
          permissions,
          meetingTypeIds: [],
          settings: { maxDurationMinutes: null, maxAdvanceDays: null, maxOccurrences: null },
          roomIds: [],
        } as never,
        f.users.admin.employeeId
      );

      return addUser("Gus Guard", group.id);
    }

    it("a group with it keeps its members' meetings from any booking, whatever the type", async () => {
      const member = await boardWith([...base, PERMISSION.BOOKING_PROTECTED]);
      const { meetings: [guarded] } = await createBooking(
        input({ participantCount: 2, participantEmployeeIds: [member] })
      );

      const error = await rejection(createBooking(byManager({ meetingTypeId: f.types.client })));

      assert.equal(error.message, PROTECTED_SLOT_MESSAGE);
      assert.equal((await meetingById(guarded.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    });

    it("protecting does not make the member's own bookings outrank anything", async () => {
      const member = await boardWith([...base, PERMISSION.BOOKING_PROTECTED]);
      const { meetings: [held] } = await createBooking(byManager());

      const error = await rejection(
        createBooking(input({ participantCount: 2, participantEmployeeIds: [member] }))
      );

      assert.equal(error.status, 409);
      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    });

    it("an optional participant protects the meeting too", async () => {
      const member = await boardWith([...base, PERMISSION.BOOKING_PROTECTED]);
      await createBooking(input({ participantCount: 2, optionalParticipantEmployeeIds: [member] }));

      const error = await rejection(createBooking(byManager()));

      assert.equal(error.message, PROTECTED_SLOT_MESSAGE);
    });

    it("with Leadership's protection switched off, a Leadership meeting can be taken over", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      const other = await addUser("Leo Lead", f.groupIds.leadership);
      await db
        .update(groupPermissions)
        .set({ isEnabled: false })
        .where(
          sql`${groupPermissions.groupId} = ${f.groupIds.leadership} AND ${groupPermissions.permissionKey} = ${PERMISSION.BOOKING_PROTECTED}`
        );
      const { meetings: [held] } = await createBooking(
        input({ participantCount: 2, participantEmployeeIds: [lead] })
      );

      // Another Leadership meeting (outranks) now takes it ...
      await createBooking(byManager({ participantCount: 2, participantEmployeeIds: [other] }));

      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    });

    it("stops protecting when the group is deactivated", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      await createBooking(input({ participantCount: 2, participantEmployeeIds: [lead] }));
      await db.update(groups).set({ isActive: false }).where(eq(groups.id, f.groupIds.leadership));

      // Leadership no longer protects, so a higher meeting type takes the room.
      const result = await createBooking(byManager({ meetingTypeId: f.types.client }));

      assert.equal(result.meetings.length, 1);
    });
  });

  it("cannot preempt a meeting that has already started", async () => {
    const today = dateFromToday(0);
    // 10:05 on the day: Bob's 10:00 meeting is under way, Mona asks for 10:20
    // (at least 15 minutes ahead, B-09).
    const { meetings: [started] } = await createBooking(
      input({ occurrenceDates: [today], now: at(today, "09:00") })
    );

    const error = await rejection(
      createBooking(
        byManager({
          occurrenceDates: [today],
          startTime: "10:20",
          endTime: "10:50",
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
    // Bob's "Others" 10:00-10:30, a Client Meeting 10:30-11:00; Mona's Team
    // Meeting wants both.
    const other = await addUser("Max Manager", f.groupIds.manager);
    const { meetings: [low] } = await createBooking(input({ endTime: "10:30" }));
    await createBooking(
      input({ startTime: "10:30", organizerEmployeeId: other, meetingTypeId: f.types.client })
    );

    const error = await rejection(createBooking(byManager()));

    assert.equal(error.status, 409);
    assert.equal((await meetingById(low.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal((await history()).length, 0);
  });

  describe("editable meeting type priority", () => {
    const rankOf = async (typeId: number) =>
      (await db.select().from(meetingTypes).where(eq(meetingTypes.meetingTypeId, typeId)))[0]
        .priorityRank;

    // Types are shared by every test in this file: put "Others" back at 5.
    afterEach(async () => {
      await db.update(meetingTypes).set({ priorityRank: 5 }).where(eq(meetingTypes.meetingTypeId, f.types.others));
    });

    it("changes who wins a room, at once, for meetings already booked", async () => {
      const admin = f.users.admin.employeeId;
      const { meetings: [held] } = await createBooking(byManager()); // Team Meeting: 3

      // "Others" is 5, so Bob's booking is refused ...
      assert.equal((await rejection(createBooking(input()))).status, 409);

      // ... until an admin ranks "Others" above Team Meeting.
      const updated = await updateMeetingTypePriority(f.types.others, 2, admin);
      assert.equal(updated.priorityRank, 2);
      assert.equal(await rankOf(f.types.others), 2);

      await createBooking(input());

      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
    });

    it("also applies to a meeting that is already held: lowering its type exposes it", async () => {
      const { meetings: [held] } = await createBooking(input()); // Others: 5

      await updateMeetingTypePriority(f.types.others, 1, f.users.admin.employeeId);
      // Team Meeting (3) no longer outranks the held "Others" (now 1).
      assert.equal((await rejection(createBooking(byManager()))).status, 409);
      assert.equal((await meetingById(held.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
    });

    it("records who changed it, and writes nothing when the value is unchanged", async () => {
      const admin = f.users.admin.employeeId;

      await updateMeetingTypePriority(f.types.others, 4, admin);
      await updateMeetingTypePriority(f.types.others, 4, admin);

      const rows = (await db.select().from(groupAuditLogs)).filter(
        (r) => r.action === "MEETING_TYPE_PRIORITY_CHANGED"
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].actorEmployeeId, admin);
      assert.deepEqual(rows[0].details, {
        meetingTypeId: f.types.others,
        name: "Others",
        from: 5,
        to: 4,
      });
    });

    it("rejects an unknown meeting type and a rank outside 1 to 5", async () => {
      const missing = await updateMeetingTypePriority(999999, 3, f.users.admin.employeeId).catch((e) => e);
      assert.ok(missing instanceof GroupError);
      assert.equal(missing.status, 404);

      for (const bad of [0, 6, 2.5, -1]) {
        assert.equal(updateMeetingTypeSchema.safeParse({ priorityRank: bad }).success, false, String(bad));
      }
      assert.equal(updateMeetingTypeSchema.safeParse({ priorityRank: 5 }).success, true);
    });
  });

  describe("room schedule (what the booking form compares)", () => {
    it("reports the meeting type's rank, and -1 (protected) for a meeting that includes Leadership", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);

      await createBooking(input({ startTime: "08:00", endTime: "09:00" })); // Others: 5
      await createBooking(
        byManager({ startTime: "09:00", endTime: "10:00", meetingTypeId: f.types.client })
      ); // Client: 1
      await createBooking(
        input({
          startTime: "11:00",
          endTime: "12:00",
          participantCount: 2,
          optionalParticipantEmployeeIds: [lead],
        })
      ); // Others + Leadership: protected

      const slots = await getRoomSchedule(f.rooms.alpha.room_id, DAY(), {
        employeeId: f.users.manager.employeeId,
        role: "Manager",
      });

      assert.deepEqual(
        slots.map((s) => [s.startTime.slice(0, 5), s.priorityRank]),
        [["08:00", 5], ["09:00", 1], ["11:00", PROTECTED_RANK]]
      );
    });
  });

  describe("recurring series", () => {
    const dates = () => [dateFromToday(7), dateFromToday(14)];

    it("takes every occurrence's slot when the series is higher priority", async () => {
      const first = await createBooking(input({ occurrenceDates: [dates()[0]] }));
      const second = await createBooking(input({ occurrenceDates: [dates()[1]] }));

      const series = await createBooking(byManager({ occurrenceDates: dates() }));

      assert.equal(series.meetings.length, 2);
      assert.equal((await meetingById(first.meetings[0].meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
      assert.equal((await meetingById(second.meetings[0].meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
      assert.equal((await history()).length, 2);
    });

    it("is refused as a whole, changing nothing, when one occurrence outranks it", async () => {
      const low = await createBooking(input({ occurrenceDates: [dates()[0]] }));
      const high = await createBooking(
        byManager({ occurrenceDates: [dates()[1]], meetingTypeId: f.types.client })
      );

      const error = await rejection(
        createBooking(byManager({ occurrenceDates: dates() }))
      );

      assert.equal(error.status, 409);
      assert.equal((await meetingById(low.meetings[0].meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
      assert.equal((await meetingById(high.meetings[0].meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
      assert.equal((await history()).length, 0);
    });

    it("overrides every occurrence when Leadership is invited", async () => {
      const lead = await addUser("Lena Lead", f.groupIds.leadership);
      const high = await createBooking(
        byManager({ occurrenceDates: [dates()[1]], meetingTypeId: f.types.client })
      );

      await createBooking(
        input({
          occurrenceDates: dates(),
          participantCount: 2,
          participantEmployeeIds: [lead],
        })
      );

      assert.equal((await meetingById(high.meetings[0].meeting_id)).meetingStatusId, MEETING_STATUS.PREEMPTED);
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
    it("lists a room whose bookings the employee's best meeting type outranks", async () => {
      await createBooking(input());

      // Mona can book a Client Meeting (1): it outranks Bob's "Others" (5).
      const rooms = await getClaimableRooms(f.users.manager.employeeId, DAY(), "10:00", "11:00", 1);
      assert.deepEqual(rooms.map((r) => r.room_id), [f.rooms.alpha.room_id]);

      // Carol's best type is Team Meeting (3), which also outranks "Others".
      assert.deepEqual(
        (await getClaimableRooms(f.users.carol.employeeId, DAY(), "10:00", "11:00", 1)).map((r) => r.room_id),
        [f.rooms.alpha.room_id]
      );
    });

    it("lists nothing when every meeting in the room is at least as high", async () => {
      await createBooking(byManager({ meetingTypeId: f.types.client }));

      assert.deepEqual(
        await getClaimableRooms(f.users.manager.employeeId, DAY(), "10:00", "11:00", 1),
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

  it("requires a strictly lower rank for every holder", () => {
    assert.equal(canBumpAll([holder(5)], 3), true);
    assert.equal(canBumpAll([holder(3)], 3), false);
    assert.equal(canBumpAll([holder(2)], 3), false);
    assert.equal(canBumpAll([holder(5), holder(2)], 3), false);
    assert.equal(canBumpAll([], 9), true);
  });

  it("lets a Leadership rank beat every meeting type, but not another Leadership meeting", () => {
    assert.equal(canBumpAll([holder(1)], claimantRank(5, true)), true);
    assert.equal(canBumpAll([holder(TOP_RANK)], claimantRank(1, true)), false);
    assert.equal(canBumpAll([holder(PROTECTED_RANK)], claimantRank(1, true)), false, "nothing beats a protected meeting");
    assert.equal(canBumpAll([holder(PROTECTED_RANK), holder(5)], claimantRank(1, true)), false);
    assert.equal(claimantRank(5, false), 5);
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
