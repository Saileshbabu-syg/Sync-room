import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  bookingPriorityHistory,
  employee,
  meeting,
  recurrence_frequency_master,
  roles,
  userGroups,
} from "@/db/schema";
import { MEETING_STATUS, PROTECTED_RANK, TOP_RANK } from "@/lib/constants";
import {
  BookingError,
  createBooking,
  PROTECTED_SLOT_MESSAGE,
  SLOT_TAKEN_MESSAGE,
  type BookingInput,
} from "@/lib/services/booking.service";
import {
  PRIORITY_BLOCK,
  canBumpAll,
  describePriorityConflicts,
  type SlotHolder,
} from "@/lib/services/priority.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";
import { rescheduleMeeting } from "@/lib/services/reschedule.service";
import {
  changeSeriesEnd,
  editSeries,
  lifecycleError,
} from "@/lib/services/series.service";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

// A recurring series follows exactly the priority rules of a single booking:
// meeting-type rank, a Leadership guest (outranks) and a protected meeting,
// checked on EVERY occurrence, all-or-nothing, with the reason reported.
// Extending a series books through the same path; moving occurrences never
// replaces anyone (the same as moving a single meeting).

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

beforeEach(async () => {
  f = await seedFixtures();
  mail?.restore();
  mail = captureMail();
});

after(() => mail?.restore());

const D1 = () => dateFromToday(7);
const D2 = () => dateFromToday(14);
const D3 = () => dateFromToday(21);
const D4 = () => dateFromToday(28);

let userSequence = 0;

async function addLeadershipUser(name: string) {
  const [role] = await db.select().from(roles).where(eq(roles.roleName, "Employee"));
  const [emp] = await db
    .insert(employee)
    .values({
      role_id: role.roleId,
      employee_name: name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${++userSequence}@example.test`,
    })
    .returning();

  await db.insert(userGroups).values({
    employeeId: emp.employee_id,
    groupId: f.groupIds.leadership,
  });

  return emp.employee_id;
}

// One meeting on `date`, Alpha 10:00-11:00.
const single = (o: Partial<BookingInput> = {}): BookingInput => ({
  title: "Existing",
  roomId: f.rooms.alpha.room_id,
  occurrenceDates: [D1()],
  startTime: "10:00",
  endTime: "11:00",
  organizerEmployeeId: f.users.bob.employeeId,
  organizerRole: "Employee",
  participantCount: 1,
  meetingTypeId: f.types.others,
  participantEmployeeIds: [],
  notify: false,
  ...o,
});

const weeklyId = async () =>
  (
    await db
      .select({ id: recurrence_frequency_master.frequency_id })
      .from(recurrence_frequency_master)
      .where(eq(recurrence_frequency_master.frequency_name, "WEEKLY"))
  )[0].id;

// A weekly series (Alpha 10:00-11:00) of `count` occurrences from D1.
async function series(
  o: Partial<Parameters<typeof createRecurringMeeting>[0]> = {},
  count = 3
) {
  return createRecurringMeeting({
    title: "Series",
    room_id: f.rooms.alpha.room_id,
    meeting_date: D1(),
    start_time: "10:00",
    end_time: "11:00",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 1,
    meetingTypeId: f.types.others,
    frequency_id: await weeklyId(),
    occurrence_count: count,
    participantEmployeeIds: [],
    notify: false,
    ...o,
  });
}

const asManager = (
  o: Partial<Parameters<typeof createRecurringMeeting>[0]> = {},
  count = 3
) =>
  series(
    {
      title: "Manager series",
      organizerEmployeeId: f.users.manager.employeeId,
      organizerRole: "Manager",
      meetingTypeId: f.types.team,
      ...o,
    },
    count
  );

async function bookingError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BookingError, `expected BookingError, got ${error}`);
    return error;
  }

  assert.fail("expected the booking to be refused");
}

async function lifecycleFailure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  const known = lifecycleError(error);

  assert.ok(known, `expected a lifecycle error, got ${String(error)}`);

  return known;
}

const statusOf = async (id: number) =>
  (await db.select().from(meeting).where(eq(meeting.meeting_id, id)))[0].meetingStatusId;

const allMeetings = () =>
  db.select().from(meeting).orderBy(asc(meeting.meeting_date), asc(meeting.meeting_id));

const history = () => db.select().from(bookingPriorityHistory);

describe("the shared priority evaluation", () => {
  const holder = (o: Partial<SlotHolder>): SlotHolder => ({
    meetingId: 1,
    title: "Held",
    roomId: 1,
    meetingDate: "2099-01-05",
    startTime: "10:00:00",
    endTime: "11:00:00",
    participantCount: 1,
    organizerEmployeeId: 1,
    groupId: null,
    priority: 5,
    ...o,
  });

  it("names the condition for each way a held meeting can stop a booking", () => {
    const codes = (h: Partial<SlotHolder>, rank: number) =>
      describePriorityConflicts([holder(h)], rank).map((c) => c.code);

    assert.deepEqual(codes({ priority: 5 }, 5), [PRIORITY_BLOCK.EQUAL_PRIORITY]);
    assert.deepEqual(codes({ priority: 1 }, 5), [PRIORITY_BLOCK.LOWER_PRIORITY]);
    assert.deepEqual(codes({ priority: PROTECTED_RANK }, TOP_RANK), [PRIORITY_BLOCK.PROTECTED_MEETING]);
    assert.deepEqual(codes({ priority: 5 }, 3), []);
    assert.deepEqual(codes({ priority: 5 }, TOP_RANK), []);
    assert.deepEqual(
      codes({ priority: 5, meetingDate: "2000-01-05" }, 3),
      [PRIORITY_BLOCK.MEETING_STARTED]
    );
  });

  it("canBumpAll agrees with it, and one blocking holder blocks the whole request", () => {
    const free = holder({ meetingId: 1, priority: 5 });
    const blocker = holder({ meetingId: 2, priority: 1, meetingDate: "2099-01-12" });

    assert.equal(canBumpAll([free], 3), true);
    assert.equal(canBumpAll([], 3), true);
    assert.equal(canBumpAll([free, blocker], 3), false);

    const conflicts = describePriorityConflicts([free, blocker], 3);

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].meetingId, 2);
    assert.equal(conflicts[0].holderPriority, 1);
    assert.equal(conflicts[0].claimantPriority, 3);
    assert.match(conflicts[0].reason, /2099-01-12 10:00-11:00/);
  });
});

describe("recurring bookings: priority of the meeting type", () => {
  it("refuses an equal-priority series and says why, exactly like a single date", async () => {
    const held = await createBooking(single({ occurrenceDates: [D2()] }));

    const asSeries = await bookingError(
      series({ organizerEmployeeId: f.users.carol.employeeId })
    );
    const asSingle = await bookingError(
      createBooking(
        single({ occurrenceDates: [D2()], organizerEmployeeId: f.users.carol.employeeId })
      )
    );

    assert.equal(asSeries.status, 409);
    assert.equal(asSeries.message, "Room is already booked for one or more occurrences");
    assert.deepEqual(asSeries.conflicts, [D2()]);
    assert.equal(asSingle.message, SLOT_TAKEN_MESSAGE);

    for (const error of [asSeries, asSingle]) {
      assert.equal(error.priorityConflicts?.length, 1);
      assert.equal(error.priorityConflicts![0].code, PRIORITY_BLOCK.EQUAL_PRIORITY);
      assert.equal(error.priorityConflicts![0].meetingId, held.meetings[0].meeting_id);
      assert.equal(error.priorityConflicts![0].holderPriority, 5);
      assert.equal(error.priorityConflicts![0].claimantPriority, 5);
      assert.match(error.reason!, /same priority 5/);
    }

    // Nothing of the series was booked.
    assert.equal((await allMeetings()).length, 1);
  });

  it("takes every lower-priority occurrence, with history, when the series outranks them", async () => {
    const a = await createBooking(single({ occurrenceDates: [D1()] }));
    const b = await createBooking(single({ occurrenceDates: [D3()] }));

    const { meetings } = await asManager();

    assert.equal(meetings.length, 3);
    assert.equal(await statusOf(a.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);
    assert.equal(await statusOf(b.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);
    assert.equal((await history()).length, 2);
  });

  it("is refused as a whole when ONE occurrence is held by a higher priority, naming that date", async () => {
    const low = await createBooking(single({ occurrenceDates: [D1()] }));
    const high = await createBooking(
      single({
        occurrenceDates: [D3()],
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
      })
    );

    const error = await bookingError(asManager());

    assert.equal(error.status, 409);
    assert.equal(error.priorityConflicts?.length, 1);
    assert.equal(error.priorityConflicts![0].code, PRIORITY_BLOCK.LOWER_PRIORITY);
    assert.equal(error.priorityConflicts![0].meetingDate, D3());
    assert.equal(error.priorityConflicts![0].holderPriority, 1);
    assert.equal(error.priorityConflicts![0].claimantPriority, 3);
    assert.match(error.reason!, new RegExp(D3()));

    // The lower-priority date was NOT taken, nothing was written.
    assert.equal(await statusOf(low.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
    assert.equal(await statusOf(high.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
    assert.equal((await history()).length, 0);
    assert.equal((await allMeetings()).length, 2);
  });
});

describe("recurring bookings: mixed availability across the dates", () => {
  it("free + takeable + blocked: refused, only the blocking date is explained, nothing changes", async () => {
    const takeable = await createBooking(single({ occurrenceDates: [D2()] }));
    const blocker = await createBooking(
      single({
        occurrenceDates: [D3()],
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
      })
    );

    // D1 is free, D2 could be taken (Others), D3 cannot (Client).
    const error = await bookingError(asManager());

    assert.deepEqual(error.conflicts, [D2(), D3()]);
    assert.deepEqual(error.occurrenceDates, [D1(), D2(), D3()]);
    assert.deepEqual(error.priorityConflicts!.map((c) => c.meetingDate), [D3()]);
    assert.equal(await statusOf(takeable.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
    assert.equal(await statusOf(blocker.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
    assert.equal((await allMeetings()).length, 2);
    assert.equal((await history()).length, 0);
  });

  it("reports every blocking date, not just the first", async () => {
    for (const date of [D1(), D3()]) {
      await createBooking(
        single({
          occurrenceDates: [date],
          organizerEmployeeId: f.users.manager.employeeId,
          organizerRole: "Manager",
          meetingTypeId: f.types.client,
        })
      );
    }

    const error = await bookingError(asManager());

    assert.deepEqual(error.priorityConflicts!.map((c) => c.meetingDate), [D1(), D3()]);
  });
});

describe("recurring bookings: Leadership members (outranks / protected)", () => {
  it("a series that invites Leadership takes a Client-meeting occurrence", async () => {
    const lead = await addLeadershipUser("Lena Lead");
    const client = await createBooking(
      single({
        occurrenceDates: [D2()],
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
      })
    );

    // Without the guest the same series is refused ...
    await bookingError(series());

    // ... with them it outranks everything that is not protected.
    const { meetings } = await series({
      participantCount: 2,
      participantEmployeeIds: [lead],
    });

    assert.equal(meetings.length, 3);
    assert.equal(await statusOf(client.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);

    const [entry] = await history();

    assert.equal(entry.incomingPriority, TOP_RANK);
  });

  it("no series can take an occurrence held by a protected meeting, and the reason says so", async () => {
    const lead = await addLeadershipUser("Lena Lead");
    const other = await addLeadershipUser("Otto Other");
    const protectedMeeting = await createBooking(
      single({
        occurrenceDates: [D2()],
        participantCount: 2,
        participantEmployeeIds: [lead],
      })
    );

    const error = await bookingError(
      series({ participantCount: 2, participantEmployeeIds: [other] })
    );

    assert.equal(error.message, PROTECTED_SLOT_MESSAGE);
    assert.equal(error.priorityConflicts![0].code, PRIORITY_BLOCK.PROTECTED_MEETING);
    assert.equal(error.priorityConflicts![0].meetingDate, D2());
    assert.equal(await statusOf(protectedMeeting.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
    assert.equal((await allMeetings()).length, 1);
  });
});

describe("recurring bookings: rules that are not priority are unchanged", () => {
  it("an occurrence nobody outranks and nobody holds is simply booked", async () => {
    const { meetings, recurringMeetingId } = await series();

    assert.equal(meetings.length, 3);
    assert.ok(recurringMeetingId > 0);
    assert.equal((await history()).length, 0);
  });

  it("an unavailable room is still refused before priority is considered", async () => {
    await assert.rejects(
      series({ room_id: f.rooms.gamma.room_id }),
      (e: unknown) => e instanceof BookingError && e.status === 409 && e.priorityConflicts === undefined
    );
  });
});

describe("extending a series applies the same priority rules", () => {
  it("is refused, adding nothing, when a new date is held by a higher priority", async () => {
    const { ids } = await seriesIds(await series({}, 3));

    await createBooking(
      single({
        occurrenceDates: [D4()],
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
      })
    );

    const error = await lifecycleFailure(
      changeSeriesEnd({
        meetingId: ids[0],
        endDate: D4(),
        actor: { employeeId: f.users.bob.employeeId, role: "Employee" },
        notify: false,
      })
    );

    assert.equal(error.status, 409);

    const details = error.details as { priorityConflicts?: { code: string; meetingDate: string }[]; reason?: string };

    assert.equal(details.priorityConflicts?.[0].code, PRIORITY_BLOCK.LOWER_PRIORITY);
    assert.equal(details.priorityConflicts?.[0].meetingDate, D4());
    assert.match(details.reason!, new RegExp(D4()));
    assert.equal((await allMeetings()).filter((m) => m.recurringMeetingId !== null).length, 3);
  });

  it("is refused for an equal-priority holder, with the equal-priority reason", async () => {
    const { ids } = await seriesIds(await series({}, 3));

    await createBooking(
      single({ occurrenceDates: [D4()], organizerEmployeeId: f.users.carol.employeeId })
    );

    const error = await lifecycleFailure(
      changeSeriesEnd({
        meetingId: ids[0],
        endDate: D4(),
        actor: { employeeId: f.users.bob.employeeId, role: "Employee" },
        notify: false,
      })
    );

    const details = error.details as { priorityConflicts?: { code: string }[] };

    assert.equal(error.status, 409);
    assert.equal(details.priorityConflicts?.[0].code, PRIORITY_BLOCK.EQUAL_PRIORITY);
  });

  it("takes a lower-priority holder on the new date, exactly as a new booking would", async () => {
    const { ids } = await seriesIds(await asManager({}));
    const low = await createBooking(single({ occurrenceDates: [D4()] }));

    const { addedMeetingIds } = await changeSeriesEnd({
      meetingId: ids[0],
      endDate: D4(),
      actor: { employeeId: f.users.manager.employeeId, role: "Manager" },
      notify: false,
    });

    assert.equal(addedMeetingIds.length, 1);
    assert.equal(await statusOf(low.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);
    assert.equal((await history()).length, 1);
  });
});

describe("moving occurrences never replaces anyone, for one meeting or a series", () => {
  const bob = () => ({ employeeId: f.users.bob.employeeId, role: "Employee" });
  const manager = () => ({ employeeId: f.users.manager.employeeId, role: "Manager" });

  // Alpha 10:00-11:00 on D2 is held by a LOWER-priority meeting (Others) than
  // the Manager's Team series; Beta is free at 10:00.
  it("a series edit onto a lower-priority holder is refused, all-or-nothing, with the reason", async () => {
    const { ids } = await seriesIds(
      await asManager({ room_id: f.rooms.beta.room_id })
    );
    const holder = await createBooking(single({ occurrenceDates: [D2()] }));

    const error = await lifecycleFailure(
      editSeries({
        meetingId: ids[0],
        scope: "series",
        actor: manager(),
        slot: { roomId: f.rooms.alpha.room_id },
        notify: false,
      })
    );

    const details = error.details as { reason?: string; conflicts?: string[]; heldBy?: number[] };

    assert.equal(error.status, 409);
    assert.equal(error.message, "Room is already booked for the selected time slot");
    assert.match(details.reason!, /never replaces another booking/);
    assert.match(details.reason!, new RegExp(D2()));
    assert.deepEqual(details.conflicts, [D2()]);
    assert.deepEqual(details.heldBy, [holder.meetings[0].meeting_id]);

    // The holder is untouched, and NO occurrence moved (not even D1, which was free).
    assert.equal(await statusOf(holder.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);

    for (const id of ids) {
      const [m] = await db.select().from(meeting).where(eq(meeting.meeting_id, id));
      assert.equal(m.room_id, f.rooms.beta.room_id);
    }

    assert.equal((await history()).length, 0);
  });

  it("moving a single meeting behaves the same way (same message, same reason)", async () => {
    const { meetings: [mine] } = await asManager({ room_id: f.rooms.beta.room_id }, 1);
    const holder = await createBooking(single({ occurrenceDates: [D1()] }));

    const error = await lifecycleFailure(
      rescheduleMeeting({
        meetingId: mine.meeting_id,
        actor: manager(),
        roomId: f.rooms.alpha.room_id,
        meetingDate: D1(),
        startTime: "10:00",
        endTime: "11:00",
        notify: false,
      })
    );

    const details = error.details as { reason?: string };

    assert.equal(error.status, 409);
    assert.equal(error.message, "Room is already booked for the selected time slot");
    assert.match(details.reason!, /never replaces another booking/);
    assert.equal(await statusOf(holder.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
  });

  it("a series edit into free slots still works", async () => {
    const { ids } = await seriesIds(await series({ room_id: f.rooms.beta.room_id }));

    const { changedMeetingIds } = await editSeries({
      meetingId: ids[0],
      scope: "series",
      actor: bob(),
      slot: { roomId: f.rooms.alpha.room_id },
      notify: false,
    });

    assert.equal(changedMeetingIds.length, 3);
  });
});

// The meeting ids of a created series, in date order.
async function seriesIds(created: { meetings: { meeting_id: number; meeting_date: string }[] }) {
  return {
    ids: [...created.meetings]
      .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date))
      .map((m) => m.meeting_id),
  };
}

// The exact scenario: a low-priority booking without Leadership exists; a
// recurring series of a high-priority meeting type that invites a Leadership
// member is booked over it, from the same room, date and time.
describe("scenario: high-priority series with a Leadership member over a low-priority booking", () => {
  // Step 1: Bob, Others (rank 5), no Leadership.
  const existing = (date: string) => createBooking(single({ occurrenceDates: [date] }));

  // Step 2: Mona, Client Meeting (rank 1) + a Leadership member, weekly.
  const leadershipSeries = async (count = 3) =>
    series(
      {
        title: "Board review",
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
        participantCount: 2,
        participantEmployeeIds: [await addLeadershipUser("Lena Lead")],
      },
      count
    );

  it("is allowed on the first occurrence and replaces the existing booking (status, history, audit)", async () => {
    const low = await existing(D1());

    assert.equal(await statusOf(low.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);

    const { meetings } = await leadershipSeries();
    const byDate = [...meetings].sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));

    assert.equal(byDate.length, 3);
    // The existing booking is Replaced (PREEMPTED); it is final, never deleted.
    assert.equal(await statusOf(low.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);

    const rows = await history();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].affectedBookingId, low.meetings[0].meeting_id);
    assert.equal(rows[0].incomingBookingId, byDate[0].meeting_id);
    assert.equal(rows[0].previousPriority, 5);
    // The rule that decided it: a priority guest is invited -> TOP_RANK, which
    // beats every meeting type (not the Client type's rank 1).
    assert.equal(rows[0].incomingPriority, TOP_RANK);
    assert.match(rows[0].reason, /priority guest is invited/);
  });

  it("follows the single-date outcome exactly", async () => {
    const low = await existing(D1());
    const lead = await addLeadershipUser("Lena Lead");

    await createBooking(
      single({
        title: "Board review",
        organizerEmployeeId: f.users.manager.employeeId,
        organizerRole: "Manager",
        meetingTypeId: f.types.client,
        participantCount: 2,
        participantEmployeeIds: [lead],
      })
    );

    assert.equal(await statusOf(low.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);
    assert.equal((await history())[0].incomingPriority, TOP_RANK);
  });

  it("checks every later occurrence on its own: each low-priority holder is replaced by its own occurrence, free dates just book", async () => {
    const first = await existing(D1());
    const third = await existing(D3()); // D2 is free

    const { meetings } = await leadershipSeries();
    const byDate = [...meetings].sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));

    assert.equal(await statusOf(first.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);
    assert.equal(await statusOf(third.meetings[0].meeting_id), MEETING_STATUS.PREEMPTED);

    const rows = await history();

    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.affectedBookingId === first.meetings[0].meeting_id)!.incomingBookingId, byDate[0].meeting_id);
    assert.equal(rows.find((r) => r.affectedBookingId === third.meetings[0].meeting_id)!.incomingBookingId, byDate[2].meeting_id);
  });

  it("is rejected as a whole, leaving the first occurrence's holder untouched, when a LATER occurrence is held by a protected meeting", async () => {
    const low = await existing(D1());
    const guard = await addLeadershipUser("Greta Guard");
    const protectedHolder = await createBooking(
      single({
        occurrenceDates: [D2()],
        participantCount: 2,
        participantEmployeeIds: [guard], // Leadership attendee protects it
      })
    );

    const error = await bookingError(leadershipSeries());

    assert.equal(error.message, PROTECTED_SLOT_MESSAGE);
    assert.deepEqual(error.priorityConflicts!.map((c) => [c.meetingDate, c.code]), [
      [D2(), PRIORITY_BLOCK.PROTECTED_MEETING],
    ]);
    assert.equal(await statusOf(low.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
    assert.equal(await statusOf(protectedHolder.meetings[0].meeting_id), MEETING_STATUS.SCHEDULED);
    assert.equal((await history()).length, 0);
    assert.equal((await allMeetings()).length, 2);
  });
});
