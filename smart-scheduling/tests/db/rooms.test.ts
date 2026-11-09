import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { groupRooms, meeting, room } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { BookingError, createBooking, type BookingInput } from "@/lib/services/booking.service";
import { getAvailableRooms } from "@/lib/services/room-suggestion.service";
import { RescheduleError, rescheduleMeeting } from "@/lib/services/reschedule.service";
import {
  RoomError,
  createRoom,
  listRoomsFor,
  setRoomArchived,
  updateRoom,
} from "@/lib/services/room.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";

// Phase 6: R-1 (who sees which rooms), R-2 (archiving), R-3 (maintenance with
// meetings still booked), R-4 (one update path).

let f: Fixtures;

beforeEach(async () => {
  f = await seedFixtures();
});

const admin = () => ({ employeeId: f.users.admin.employeeId, role: "Admin" });
const bob = () => ({ employeeId: f.users.bob.employeeId, role: "Employee" });

const input = (o: Partial<BookingInput> = {}): BookingInput => ({
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
  notify: false,
  ...o,
});

const alphaInput = (o: Partial<Parameters<typeof updateRoom>[1]> = {}) => ({
  roomName: "Alpha",
  roomCapacity: 10,
  roomLocation: "Floor 1",
  availabilityStatusId: 1,
  ...o,
});

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  assert.ok(error instanceof RoomError || error instanceof BookingError || error instanceof RescheduleError, String(error));
  return error;
}

describe("R-1: who sees which rooms", () => {
  it("room managers see every room; others only the active rooms their group may book", async () => {
    await db.insert(groupRooms).values({ groupId: f.groupIds.employee, roomId: f.rooms.alpha.room_id });

    const forAdmin = await listRoomsFor(admin());
    assert.equal(forAdmin.canManage, true);
    assert.deepEqual(forAdmin.rooms.map((r) => r.room_name).sort(), ["Alpha", "Beta", "Gamma"]);

    const forBob = await listRoomsFor(bob());
    assert.equal(forBob.canManage, false);
    assert.deepEqual(forBob.rooms.map((r) => r.room_name), ["Alpha"], "Bob's group may only book Alpha");
  });

  it("archived rooms are listed only for managers who ask, never offered for booking", async () => {
    await setRoomArchived(f.rooms.beta.room_id, true);

    assert.ok(!(await listRoomsFor(bob())).rooms.some((r) => r.room_id === f.rooms.beta.room_id));
    assert.ok(!(await listRoomsFor(admin())).rooms.some((r) => r.room_id === f.rooms.beta.room_id));
    assert.ok((await listRoomsFor(admin(), { includeArchived: true })).rooms.some((r) => r.room_id === f.rooms.beta.room_id));

    const free = await getAvailableRooms(dateFromToday(7), "10:00", "11:00");
    assert.ok(!free.some((r) => r.room_id === f.rooms.beta.room_id));
  });

  it("filters by facility, treating % and _ literally", async () => {
    await db.update(room).set({ facilities: "Projector, TV" }).where(eq(room.room_id, f.rooms.alpha.room_id));

    assert.deepEqual((await listRoomsFor(admin(), { facility: "projector" })).rooms.map((r) => r.room_name), []);
    assert.deepEqual((await listRoomsFor(admin(), { facility: "Projector" })).rooms.map((r) => r.room_name), ["Alpha"]);
    assert.deepEqual((await listRoomsFor(admin(), { facility: "%" })).rooms.length, 0);
  });
});

describe("R-2: archiving", () => {
  it("an archived room cannot be booked or moved into; restoring makes it bookable again", async () => {
    const { meetings: [m] } = await createBooking(input({ roomId: f.rooms.alpha.room_id }));

    await setRoomArchived(f.rooms.beta.room_id, true);

    assert.equal((await failure(createBooking(input({ roomId: f.rooms.beta.room_id, startTime: "12:00", endTime: "13:00" })))).status, 409);
    const move = await failure(
      rescheduleMeeting({ meetingId: m.meeting_id, actor: bob(), roomId: f.rooms.beta.room_id, meetingDate: dateFromToday(8), startTime: "10:00", endTime: "11:00", notify: false })
    );
    assert.equal(move.status, 409);
    assert.match(move.message, /archived/);

    await setRoomArchived(f.rooms.beta.room_id, false);
    const { meetings } = await createBooking(input({ roomId: f.rooms.beta.room_id, startTime: "12:00", endTime: "13:00", participantCount: 1, participantEmployeeIds: [] }));
    assert.equal(meetings.length, 1);
  });

  it("is refused while meetings are booked in the room, listing them", async () => {
    const { meetings: [m] } = await createBooking(input());

    const error = (await failure(setRoomArchived(f.rooms.alpha.room_id, true))) as RoomError;

    assert.equal(error.status, 409);
    assert.deepEqual(error.conflicts?.map((c) => c.meetingId), [m.meeting_id]);
    assert.equal((await db.select().from(room).where(eq(room.room_id, f.rooms.alpha.room_id)))[0].archived_at, null);
  });

  it("past meetings keep their room after it is archived", async () => {
    const { meetings: [m] } = await createBooking(input());
    await db.update(meeting).set({ meeting_date: dateFromToday(-3), meetingStatusId: MEETING_STATUS.COMPLETED }).where(eq(meeting.meeting_id, m.meeting_id));

    await setRoomArchived(f.rooms.alpha.room_id, true);

    const [kept] = await db.select().from(meeting).where(eq(meeting.meeting_id, m.meeting_id));
    assert.equal(kept.room_id, f.rooms.alpha.room_id);
  });

  it("creates rooms through the same service", async () => {
    const created = await createRoom({ roomName: "Delta", roomCapacity: 6, roomLocation: "Floor 4", availabilityStatusId: 1 });

    assert.equal(created.room_name, "Delta");
    assert.equal(created.archived_at, null);
    assert.equal((await failure(createRoom({ roomName: "Bad", roomCapacity: 6, availabilityStatusId: 999 }))).status, 400);
  });
});

describe("R-3 / R-4: one update path with the same guards", () => {
  it("taking a room out of service is refused while meetings are booked in it; nothing is cancelled", async () => {
    const { meetings: [m] } = await createBooking(input());

    const error = (await failure(updateRoom(f.rooms.alpha.room_id, alphaInput({ availabilityStatusId: 2 })))) as RoomError;

    assert.equal(error.status, 409);
    assert.match(error.message, /1 upcoming meeting/);
    assert.equal(error.conflicts?.[0].meetingId, m.meeting_id);

    const [r] = await db.select().from(room).where(eq(room.room_id, f.rooms.alpha.room_id));
    assert.equal(r.availabilityStatusId, 1, "unchanged");
    assert.equal((await db.select().from(meeting).where(eq(meeting.meeting_id, m.meeting_id)))[0].meetingStatusId, MEETING_STATUS.SCHEDULED);
  });

  it("is allowed once the meetings are gone, and other edits never need it", async () => {
    const { meetings: [m] } = await createBooking(input());

    await updateRoom(f.rooms.alpha.room_id, alphaInput({ roomDescription: "Bright corner room" }));

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.CANCELLED }).where(eq(meeting.meeting_id, m.meeting_id));
    const updated = await updateRoom(f.rooms.alpha.room_id, alphaInput({ availabilityStatusId: 2 }));
    assert.equal(updated.availabilityStatusId, 2);
  });

  it("guards capacity against upcoming meetings, including ones waiting to be rescheduled", async () => {
    const { meetings: [m] } = await createBooking(input({ participantCount: 3 }));
    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.PENDING_RESCHEDULE }).where(eq(meeting.meeting_id, m.meeting_id));

    assert.equal((await failure(updateRoom(f.rooms.alpha.room_id, alphaInput({ roomCapacity: 2 })))).status, 409);
    assert.equal((await updateRoom(f.rooms.alpha.room_id, alphaInput({ roomCapacity: 3 }))).room_capacity, 3);
  });

  it("an unknown room is 404", async () => {
    assert.equal((await failure(updateRoom(99_999, alphaInput()))).status, 404);
    assert.equal((await failure(setRoomArchived(99_999, true))).status, 404);
  });
});
