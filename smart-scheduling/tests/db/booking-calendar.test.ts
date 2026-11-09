import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  groupMeetingTypes,
  groupPermissions,
  groupRooms,
  groupSettings,
  meeting,
  meeting_attendees,
  notifications,
  recurrence_frequency_master,
} from "@/db/schema";
import { MEETING_STATUS, PERMISSION } from "@/lib/constants";
import { computeOccurrenceDates } from "@/lib/recurrence";
import { BookingError, createBooking, type BookingInput } from "@/lib/services/booking.service";
import {
  deliverNotification,
  queueMeetingNotification,
} from "@/lib/services/notification.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { RescheduleError, rescheduleMeeting } from "@/lib/services/reschedule.service";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

// Phase 3: B-01 (duration), B-02 (reschedule policy), B-08 (organizer counted
// once), M-4 (frequencies by name), H-2 (calendar lifecycle through the outbox).

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

beforeEach(async () => {
  f = await seedFixtures();
  mail?.restore();
  mail = captureMail();
});

after(() => mail?.restore());

const input = (o: Partial<BookingInput> = {}): BookingInput => ({
  title: "Planning",
  roomId: f.rooms.alpha.room_id,
  occurrenceDates: [dateFromToday(7)],
  startTime: "10:00",
  endTime: "11:00",
  organizerEmployeeId: f.users.bob.employeeId,
  organizerRole: "Employee",
  participantCount: 2,
  meetingTypeId: f.types.team,
  participantEmployeeIds: [f.users.carol.employeeId],
  notify: false,
  ...o,
});

async function rejected(promise: Promise<unknown>, status: number, message?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );

  assert.ok(
    error instanceof BookingError || error instanceof RescheduleError,
    `expected a booking/reschedule error, got ${String(error)}`
  );
  assert.equal(error.status, status, error.message);
  if (message) assert.match(error.message, message);
}

const meetingRow = async (id: number) =>
  (await db.select().from(meeting).where(eq(meeting.meeting_id, id)))[0];

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
const prop = (ics: string, name: string) =>
  unfold(ics).split("\r\n").find((l) => l.startsWith(`${name}:`));

const frequencyId = async (name: string) =>
  (
    await db
      .select({ id: recurrence_frequency_master.frequency_id })
      .from(recurrence_frequency_master)
      .where(eq(recurrence_frequency_master.frequency_name, name))
  )[0].id;

const series = (o: Partial<Parameters<typeof createRecurringMeeting>[0]> = {}) => ({
  title: "Standup",
  room_id: f.rooms.alpha.room_id,
  meeting_date: nextWeekday(7),
  start_time: "10:00",
  end_time: "10:30",
  organizerEmployeeId: f.users.bob.employeeId,
  organizerRole: "Employee",
  participantCount: 1,
  meetingTypeId: f.types.team,
  frequency_id: 0,
  occurrence_count: 3,
  notify: false,
  ...o,
});

// A Monday-to-Friday date at least `days` ahead (daily series start on one).
function nextWeekday(days: number) {
  for (let d = days; ; d++) {
    const date = dateFromToday(d);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

    if (weekday !== 0 && weekday !== 6) return date;
  }
}

describe("minimum duration on the server (B-01)", () => {
  it("a single meeting: 14 minutes is refused, exactly 15 is booked", async () => {
    await rejected(createBooking(input({ endTime: "10:14" })), 400, /at least 15 minutes/);

    const { meetings } = await createBooking(input({ endTime: "10:15" }));
    assert.equal(meetings.length, 1);
  });

  it("a recurring series: 14 minutes is refused", async () => {
    await rejected(
      createRecurringMeeting(series({ frequency_id: await frequencyId("WEEKLY"), end_time: "10:14" })),
      400,
      /at least 15 minutes/
    );
    assert.equal((await db.select().from(meeting)).length, 0);
  });
});

describe("organizer counted once (B-08)", () => {
  it("listing the organizer as a participant does not use up a seat", async () => {
    const { meetings } = await createBooking(
      input({
        participantCount: 2,
        participantEmployeeIds: [f.users.bob.employeeId, f.users.carol.employeeId],
      })
    );

    const attendees = await db
      .select()
      .from(meeting_attendees)
      .where(eq(meeting_attendees.meeting_id, meetings[0].meeting_id));

    assert.deepEqual(
      attendees.map((a) => a.employee_id).sort(),
      [f.users.bob.employeeId, f.users.carol.employeeId].sort()
    );
  });
});

describe("recurrence frequencies resolved by name (M-4)", () => {
  for (const name of ["DAILY", "WEEKLY", "MONTHLY"] as const) {
    it(`${name} books the dates its pattern produces`, async () => {
      const start = nextWeekday(7);
      const { meetings } = await createRecurringMeeting(
        series({ frequency_id: await frequencyId(name), meeting_date: start })
      );

      assert.deepEqual(
        meetings.map((m) => m.meeting_date).sort(),
        computeOccurrenceDates(start, name, 3)
      );
    });
  }

  it("an unknown frequency id is 404, a stored but unsupported frequency is refused", async () => {
    await rejected(createRecurringMeeting(series({ frequency_id: 99_999 })), 404);

    const [yearly] = await db
      .insert(recurrence_frequency_master)
      .values({ frequency_name: "YEARLY" })
      .returning();

    await rejected(createRecurringMeeting(series({ frequency_id: yearly.frequency_id })), 400, /not supported/);
    assert.equal((await db.select().from(meeting)).length, 0, "nothing booked");
  });
});

describe("rescheduling follows the booking rules (B-02, B-01)", () => {
  // Bob's meeting, bumped and waiting to be moved; Carol accepted it.
  async function bumped() {
    const { meetings } = await createBooking(input());
    const id = meetings[0].meeting_id;

    await db
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.PENDING_RESCHEDULE })
      .where(eq(meeting.meeting_id, id));
    await db
      .update(meeting_attendees)
      .set({ response_status: "ACCEPTED" })
      .where(eq(meeting_attendees.employee_id, f.users.carol.employeeId));

    return { id, before: await meetingRow(id) };
  }

  const move = (meetingId: number, o: Partial<Parameters<typeof rescheduleMeeting>[0]> = {}) =>
    rescheduleMeeting({
      meetingId,
      actor: { employeeId: f.users.bob.employeeId, role: "Employee" },
      roomId: f.rooms.beta.room_id,
      meetingDate: dateFromToday(8),
      startTime: "10:00",
      endTime: "10:30",
      notify: false,
      ...o,
    });

  async function unchanged(id: number, before: typeof meeting.$inferSelect) {
    const now = await meetingRow(id);

    assert.deepEqual(
      [now.room_id, now.meeting_date, now.start_time, now.end_time, now.meetingStatusId, now.ics_sequence],
      [before.room_id, before.meeting_date, before.start_time, before.end_time, before.meetingStatusId, before.ics_sequence],
      "the refused reschedule left the meeting as it was"
    );
  }

  it("refuses less than 15 minutes", async () => {
    const { id, before } = await bumped();

    await rejected(move(id, { endTime: "10:14" }), 400, /at least 15 minutes/);
    await unchanged(id, before);
  });

  it("refuses anyone but the organizer or an Admin", async () => {
    const { id, before } = await bumped();

    await rejected(move(id, { actor: { employeeId: f.users.carol.employeeId, role: "Employee" } }), 403);
    await unchanged(id, before);
  });

  it("refuses a room the organizer's group may not use", async () => {
    const { id, before } = await bumped();
    await db.insert(groupRooms).values({ groupId: f.groupIds.employee, roomId: f.rooms.alpha.room_id });

    await rejected(move(id), 403, /not allowed to book this room/);
    await unchanged(id, before);
  });

  it("refuses a meeting longer than the group allows", async () => {
    const { id, before } = await bumped();
    await db
      .insert(groupSettings)
      .values({ groupId: f.groupIds.employee, maxDurationMinutes: 30, maxAdvanceDays: null, maxOccurrences: null })
      .onConflictDoUpdate({ target: groupSettings.groupId, set: { maxDurationMinutes: 30 } });

    await rejected(move(id, { endTime: "11:00" }), 400, /at most/);
    await unchanged(id, before);
  });

  it("refuses a date beyond the group's limit or the booking window", async () => {
    const { id, before } = await bumped();
    await db
      .insert(groupSettings)
      .values({ groupId: f.groupIds.employee, maxDurationMinutes: null, maxAdvanceDays: 5, maxOccurrences: null })
      .onConflictDoUpdate({ target: groupSettings.groupId, set: { maxAdvanceDays: 5 } });

    await rejected(move(id), 400, /days ahead/);
    await rejected(move(id, { meetingDate: dateFromToday(200) }), 400, /3 months/);
    await unchanged(id, before);
  });

  it("refuses when the group may no longer book the meeting type, or book at all", async () => {
    const { id, before } = await bumped();

    await db
      .delete(groupMeetingTypes)
      .where(and(eq(groupMeetingTypes.groupId, f.groupIds.employee), eq(groupMeetingTypes.meetingTypeId, f.types.team)));
    await rejected(move(id), 403, /meeting type/);

    await db
      .update(groupPermissions)
      .set({ isEnabled: false })
      .where(
        and(
          eq(groupPermissions.groupId, f.groupIds.employee),
          eq(groupPermissions.permissionKey, PERMISSION.BOOKING_CREATE)
        )
      );
    await rejected(move(id), 403, /not allowed to create bookings/);
    await unchanged(id, before);
  });

  it("refuses a slot that is taken, without bumping anyone", async () => {
    const { id, before } = await bumped();
    const { meetings: [other] } = await createBooking(
      input({ roomId: f.rooms.beta.room_id, occurrenceDates: [dateFromToday(8)], participantEmployeeIds: [], participantCount: 1, organizerEmployeeId: f.users.carol.employeeId })
    );

    await rejected(move(id), 409);
    await unchanged(id, before);
    assert.equal((await meetingRow(other.meeting_id)).meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("succeeds within the rules: answers kept, calendar version raised, update queued with the new details", async () => {
    const { id, before } = await bumped();

    const { notificationId } = await move(id);

    const after = await meetingRow(id);
    assert.equal(after.meetingStatusId, MEETING_STATUS.SCHEDULED);
    assert.equal(after.room_id, f.rooms.beta.room_id);
    assert.equal(after.ics_sequence, before.ics_sequence + 1);

    const [carol] = await db
      .select()
      .from(meeting_attendees)
      .where(and(eq(meeting_attendees.meeting_id, id), eq(meeting_attendees.employee_id, f.users.carol.employeeId)));
    assert.equal(carol.response_status, "ACCEPTED", "the answer survives the move");

    assert.equal(await deliverNotification(notificationId), "SENT");
    const m = mail.sent.at(-1)!;

    assert.match(m.subject, /Updated/);
    assert.equal(prop(m.ics, "METHOD"), "METHOD:REQUEST");
    assert.equal(prop(m.ics, "UID"), `UID:meeting-${id}@meetsched.local`);
    assert.equal(prop(m.ics, "SEQUENCE"), "SEQUENCE:1");
    assert.equal(prop(m.ics, "LOCATION"), "LOCATION:Beta");
    assert.match(prop(m.ics, "DTSTART") ?? "", /T043000Z$/, "10:00 IST");
    assert.match(prop(m.ics, "DTEND") ?? "", /T050000Z$/, "10:30 IST");
  });
});

describe("calendar entry lifecycle through the outbox (H-2)", () => {
  it("booking, reminder and cancellation all address the same entry; versions only rise on real changes", async () => {
    const result = await createBooking(input());
    const id = result.meetings[0].meeting_id;
    const uid = `UID:meeting-${id}@meetsched.local`;

    assert.equal(await deliverNotification(result.notificationId), "SENT");
    assert.equal(await deliverNotification(result.invitationNotificationIds[0]), "SENT");

    const [confirmation, invitation] = mail.sent;

    for (const m of [confirmation, invitation]) {
      assert.equal(prop(m.ics, "UID"), uid);
      assert.equal(prop(m.ics, "SEQUENCE"), "SEQUENCE:0");
      assert.equal(prop(m.ics, "METHOD"), "METHOD:REQUEST");
      assert.equal(prop(m.ics, "LOCATION"), "LOCATION:Alpha");
    }

    // Generating again (another e-mail) does not change the version.
    await deliverNotification(await queueMeetingNotification(db, id, "UPDATED"));
    assert.equal(prop(mail.sent.at(-1)!.ics, "SEQUENCE"), "SEQUENCE:0");
    assert.equal((await meetingRow(id)).ics_sequence, 0);

    // Cancelled: a CANCEL for the same entry, above every version sent.
    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.CANCELLED }).where(eq(meeting.meeting_id, id));
    assert.equal(await deliverNotification(await queueMeetingNotification(db, id, "CANCELLED")), "SENT");

    const cancel = mail.sent.at(-1)!;
    assert.equal(prop(cancel.ics, "METHOD"), "METHOD:CANCEL");
    assert.equal(prop(cancel.ics, "UID"), uid);
    assert.equal(prop(cancel.ics, "SEQUENCE"), "SEQUENCE:1");
    assert.equal(prop(cancel.ics, "STATUS"), "STATUS:CANCELLED");
  });

  it("a series confirmation lists every occurrence under its own entry", async () => {
    const { meetings } = await createRecurringMeeting(
      series({ frequency_id: await frequencyId("WEEKLY"), participantCount: 1 })
    );

    const [n] = await db.select().from(notifications);
    assert.equal(await deliverNotification(n.notification_id), "SENT");

    const ics = unfold(mail.sent[0].ics);
    assert.equal(prop(ics, "METHOD"), "METHOD:PUBLISH");
    assert.deepEqual(
      ics.split("\r\n").filter((l) => l.startsWith("UID:")).sort(),
      meetings.map((m) => `UID:meeting-${m.meeting_id}@meetsched.local`).sort()
    );
  });
});
