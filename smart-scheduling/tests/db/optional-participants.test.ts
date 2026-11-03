import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, meeting_attendees, notifications } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { createBooking, type BookingInput } from "@/lib/services/booking.service";
import { getBumpInfo } from "@/lib/services/bump-info.service";
import { respondToInvitation } from "@/lib/services/invitation.service";
import {
  deliverNotification,
} from "@/lib/services/notification.service";
import { getAllowedMeetingTypes } from "@/lib/services/meeting-type-access.service";
import { updateGroup } from "@/lib/services/group.service";

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
    TRUNCATE booking_priority_history, meeting_audit_logs, reminder_logs,
      notifications, reschedule_requests, meeting_attendees, meeting,
      recurring_meetings
    RESTART IDENTITY CASCADE
  `);

  // Put the Employee group back to its seeded state; some tests change it.
  await updateGroup(
    f.groupIds.employee,
    {
      isActive: true,
      meetingTypeIds: [f.types.team, f.types.oneOnOne, f.types.others],
    },
    f.users.admin.employeeId
  );
});

// Bob organizes; Carol is mandatory, Dave optional.
function input(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    title: "Planning",
    roomId: f.rooms.alpha.room_id,
    occurrenceDates: [dateFromToday(7)],
    startTime: "10:00",
    endTime: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 3,
    meetingTypeId: f.types.team,
    participantEmployeeIds: [f.users.carol.employeeId],
    optionalParticipantEmployeeIds: [f.users.dave.employeeId],
    notify: false,
    ...overrides,
  };
}

const attendee = async (meetingId: number, employeeId: number) =>
  (
    await db
      .select()
      .from(meeting_attendees)
      .where(
        and(
          eq(meeting_attendees.meeting_id, meetingId),
          eq(meeting_attendees.employee_id, employeeId)
        )
      )
  )[0];

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string };
  }

  assert.fail("expected the call to be rejected");
};

describe("booking with optional participants", () => {
  it("stores each person's kind and starts everyone without an answer", async () => {
    const { meetings: [m] } = await createBooking(input());

    const carol = await attendee(m.meeting_id, f.users.carol.employeeId);
    const dave = await attendee(m.meeting_id, f.users.dave.employeeId);
    const bob = await attendee(m.meeting_id, f.users.bob.employeeId);

    assert.equal(carol.is_optional, false);
    assert.equal(dave.is_optional, true);
    assert.equal(bob.is_optional, false);
    assert.equal(carol.response_status, "NO_RESPONSE");
    assert.equal(dave.response_status, "NO_RESPONSE");
    assert.equal(bob.response_status, "ACCEPTED");
  });

  it("invites both kinds, and only the optional one is told it is optional", async () => {
    const result = await createBooking(input());

    assert.equal(result.invitationNotificationIds.length, 2);

    for (const id of result.invitationNotificationIds) {
      assert.equal(await deliverNotification(id), "SENT");
    }

    const to = (email: string) => mail.sent.find((m) => m.to === email)!;
    const forCarol = to(f.users.carol.email);
    const forDave = to(f.users.dave.email);

    assert.ok(forCarol && forDave);
    assert.ok(!/optional/i.test(forCarol.text), "a mandatory participant sees no 'optional'");
    assert.match(forDave.text, /as an optional participant/);
    assert.match(forDave.text, /Accept: http/);
    assert.match(forDave.text, /Decline: http/);
    assert.match(forDave.html, />Accept</);
    assert.match(forDave.html, />Decline</);
  });

  it("rejects someone listed as both mandatory and optional, and the organizer as optional", async () => {
    const both = await failure(
      createBooking(
        input({
          participantEmployeeIds: [f.users.carol.employeeId],
          optionalParticipantEmployeeIds: [f.users.carol.employeeId],
        })
      )
    );

    assert.equal(both.status, 400);

    const organizer = await failure(
      createBooking(input({ optionalParticipantEmployeeIds: [f.users.bob.employeeId] }))
    );

    assert.equal(organizer.status, 400);
    assert.equal((await db.select().from(meeting)).length, 0);
  });

  it("counts optional people in the headcount limit", async () => {
    const error = await failure(createBooking(input({ participantCount: 2 })));

    assert.equal(error.status, 400);

    await createBooking(input({ participantCount: 3 }));
  });

  it("an optional participant's answer never changes the meeting, and answers are tracked separately", async () => {
    const { meetings: [m] } = await createBooking(input());

    assert.equal((await respondToInvitation(m.meeting_id, f.users.dave.employeeId, "decline")).status, "recorded");

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, m.meeting_id));

    assert.equal(row.meetingStatusId, MEETING_STATUS.SCHEDULED, "the meeting is not cancelled");
    assert.equal((await attendee(m.meeting_id, f.users.dave.employeeId)).response_status, "DECLINED");
    assert.equal((await attendee(m.meeting_id, f.users.carol.employeeId)).response_status, "NO_RESPONSE");

    // The room is still held: nobody equal in priority can take it.
    const clash = await failure(
      createBooking(input({ title: "Clash", organizerEmployeeId: f.users.carol.employeeId, participantEmployeeIds: [], optionalParticipantEmployeeIds: [], participantCount: 1 }))
    );

    assert.equal(clash.status, 409);
  });

  it("works without any optional participants (the old request shape)", async () => {
    const { meetings: [m] } = await createBooking(input({ optionalParticipantEmployeeIds: undefined, participantCount: 2 }));

    assert.equal((await attendee(m.meeting_id, f.users.dave.employeeId)), undefined);
    assert.equal((await attendee(m.meeting_id, f.users.carol.employeeId)).is_optional, false);
  });

  it("recurring series carry the kind on every occurrence", async () => {
    const { meetings } = await createBooking(
      input({
        occurrenceDates: [dateFromToday(7), dateFromToday(14)],
        recurrence: { frequencyId: 2, occurrenceCount: 2 },
      })
    );

    for (const m of meetings) {
      assert.equal((await attendee(m.meeting_id, f.users.dave.employeeId)).is_optional, true);
      assert.equal((await attendee(m.meeting_id, f.users.carol.employeeId)).is_optional, false);
    }
  });

  it("queues no extra invitation for the organizer", async () => {
    await createBooking(input());

    const invites = (await db.select().from(notifications)).filter((n) => n.recipient_employee_id !== null);

    assert.deepEqual(
      invites.map((n) => n.recipient_employee_id).sort(),
      [f.users.carol.employeeId, f.users.dave.employeeId].sort()
    );
  });
});

describe("meeting types follow the group", () => {
  it("lists only what the organizer's group may book", async () => {
    const names = (await getAllowedMeetingTypes({ employeeId: f.users.bob.employeeId, roleName: "Employee" })).map(
      (t) => t.meetingTypeName
    );

    assert.deepEqual(names.sort(), ["One-on-One", "Others", "Team Meeting"]);
  });

  it("an admin change takes effect on the next booking, and can take a type away", async () => {
    const asBob = (typeId: number) =>
      input({
        meetingTypeId: typeId,
        participantEmployeeIds: [],
        optionalParticipantEmployeeIds: [],
        participantCount: 1,
      });

    assert.equal((await failure(createBooking(asBob(f.types.client)))).status, 403);

    await updateGroup(
      f.groupIds.employee,
      { meetingTypeIds: [f.types.client] },
      f.users.admin.employeeId
    );

    await createBooking(asBob(f.types.client));

    assert.equal(
      (await failure(createBooking(asBob(f.types.team)))).status,
      403,
      "Team Meeting was un-ticked for the group"
    );
  });

  it("an inactive group falls back to the role's list", async () => {
    await updateGroup(f.groupIds.employee, { meetingTypeIds: [], isActive: false }, f.users.admin.employeeId);

    const names = (await getAllowedMeetingTypes({ employeeId: f.users.bob.employeeId, roleName: "Employee" })).map(
      (t) => t.meetingTypeName
    );

    assert.deepEqual(names.sort(), ["One-on-One", "Others", "Team Meeting"]);
  });
});

describe("who bumped a booking", () => {
  it("gives the replacement meeting, its organizer, group and the reason", async () => {
    const date = dateFromToday(9);
    const base = {
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [date],
      startTime: "10:00",
      endTime: "11:00",
      organizerRole: "Manager",
      participantCount: 1,
      meetingTypeId: f.types.team,
      notify: false,
    };

    const low = (await createBooking({ ...base, title: "Low", organizerEmployeeId: f.users.bob.employeeId })).meetings[0];
    const high = (await createBooking({ ...base, title: "High", organizerEmployeeId: f.users.manager.employeeId })).meetings[0];

    const info = (await getBumpInfo([low.meeting_id, high.meeting_id]));

    assert.equal(info.size, 1, "only the bumped booking has bump details");

    const bump = info.get(low.meeting_id)!;

    assert.equal(bump.byName, f.users.manager.name);
    assert.equal(bump.byGroup, "Manager");
    assert.equal(bump.title, "High");
    assert.equal(bump.byBookingId, high.meeting_id);
    assert.equal(bump.roomName, "Alpha");
    assert.equal(bump.meetingDate, date);
    assert.match(bump.reason, /outranks/);

    assert.equal((await getBumpInfo([])).size, 0);
  });
});
