import { and, asc, eq, inArray, isNull, like, sql } from "drizzle-orm";

import { db } from "@/db";
import { availabilityMaster, meeting, room } from "@/db/schema";
import { AVAILABILITY_STATUS, MEETING_STATUS } from "@/lib/constants";
import type { DbExecutor, Tx } from "@/lib/db-types";
import { nowInAppTimezone } from "@/lib/time";

import { meetingEndsAt } from "./conflict-check.service";
import { canUseRoom, getBookingPolicy } from "./booking-policy.service";
import { canManageRooms } from "./group-context.service";
import { ROOM_LOCK_NAMESPACE } from "./reschedule.service";

// The one place rooms are created, changed, archived and listed. Both room
// update routes call updateRoom, so every update gets the same checks.

export class RoomError extends Error {
  status: number;
  // Upcoming meetings that stand in the way (maintenance / archive).
  conflicts?: RoomConflict[];

  constructor(message: string, status: number, conflicts?: RoomConflict[]) {
    super(message);
    this.name = "RoomError";
    this.status = status;
    this.conflicts = conflicts;
  }
}

export type RoomConflict = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
};

export type RoomInput = {
  roomName: string;
  roomCapacity: number;
  roomLocation?: string | null;
  facilities?: string | null;
  roomDescription?: string | null;
  availabilityStatusId: number;
};

type Viewer = { employeeId: number; role: string };

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

// Meetings that still take place in this room: scheduled (or waiting to be
// rescheduled) and not ended yet.
async function upcomingMeetings(executor: DbExecutor, roomId: number, now?: Date) {
  const today = nowInAppTimezone(now);

  const rows = await executor
    .select({
      meetingId: meeting.meeting_id,
      title: meeting.title,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      participants: meeting.participantCount,
    })
    .from(meeting)
    .where(
      and(
        eq(meeting.room_id, roomId),
        inArray(meeting.meetingStatusId, [
          MEETING_STATUS.SCHEDULED,
          MEETING_STATUS.PENDING_RESCHEDULE,
        ]),
        // Not ended yet: the end (the next day for an overnight meeting) is
        // still ahead of the application's wall clock.
        sql`${meetingEndsAt} > ${`${today.date} ${today.time}`}::timestamp`
      )
    )
    .orderBy(asc(meeting.meeting_date), asc(meeting.start_time));

  return rows;
}

const asConflicts = (rows: Awaited<ReturnType<typeof upcomingMeetings>>): RoomConflict[] =>
  rows.map(({ meetingId, title, meetingDate, startTime, endTime }) => ({
    meetingId,
    title,
    meetingDate: String(meetingDate),
    startTime: String(startTime).slice(0, 5),
    endTime: String(endTime).slice(0, 5),
  }));

// The room locked for a change, under the same advisory lock bookings take,
// so no booking can slip in between the checks below and the change.
async function lockRoom(tx: Tx, roomId: number) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, ${roomId})`);

  const [existing] = await tx
    .select()
    .from(room)
    .where(eq(room.room_id, roomId))
    .for("update");

  if (!existing) throw new RoomError("Room not found.", 404);

  return existing;
}

async function assertStatusExists(executor: DbExecutor, statusId: number) {
  const [status] = await executor
    .select({ id: availabilityMaster.availabilityStatusId })
    .from(availabilityMaster)
    .where(eq(availabilityMaster.availabilityStatusId, statusId));

  if (!status) throw new RoomError("Invalid availability status.", 400);
}

function conflictError(action: string, rows: Awaited<ReturnType<typeof upcomingMeetings>>) {
  return new RoomError(
    `This room has ${rows.length} upcoming meeting${rows.length === 1 ? "" : "s"}. ` +
      `Move or cancel ${rows.length === 1 ? "it" : "them"} before ${action}; nothing was changed.`,
    409,
    asConflicts(rows)
  );
}

export async function createRoom(input: RoomInput) {
  await assertStatusExists(db, input.availabilityStatusId);

  const [created] = await db
    .insert(room)
    .values({
      room_name: input.roomName,
      room_capacity: input.roomCapacity,
      roomLocation: input.roomLocation || null,
      facilities: input.facilities || null,
      availabilityStatusId: input.availabilityStatusId,
      roomDescription: input.roomDescription || null,
    })
    .returning();

  return created;
}

// Changes a room. Refused (409, nothing changed) when the capacity would drop
// below an upcoming meeting's headcount, or when the room would be taken out
// of service (any status other than Available) while meetings are still booked
// in it: those are listed so an administrator can move or cancel them first.
// Existing bookings are never cancelled or moved by this.
export async function updateRoom(roomId: number, input: RoomInput, now?: Date) {
  return db.transaction(async (tx) => {
    const existing = await lockRoom(tx, roomId);

    await assertStatusExists(tx, input.availabilityStatusId);

    const upcoming = await upcomingMeetings(tx, roomId, now);
    const largest = Math.max(0, ...upcoming.map((m) => m.participants));

    if (input.roomCapacity < largest) {
      throw new RoomError(
        `Capacity cannot be lower than ${largest}: an upcoming meeting in this room has that many participants.`,
        409
      );
    }

    if (
      input.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE &&
      existing.availabilityStatusId === AVAILABILITY_STATUS.AVAILABLE &&
      upcoming.length > 0
    ) {
      throw conflictError("taking the room out of service", upcoming);
    }

    const [updated] = await tx
      .update(room)
      .set({
        room_name: input.roomName,
        room_capacity: input.roomCapacity,
        roomLocation: input.roomLocation || null,
        facilities: input.facilities || null,
        roomDescription: input.roomDescription || null,
        availabilityStatusId: input.availabilityStatusId,
        updated_at: new Date(),
      })
      .where(eq(room.room_id, roomId))
      .returning();

    return updated;
  });
}

// Archives (or restores) a room. Archived rooms cannot be booked or offered,
// but stay in the database: meetings held in them keep their room. Archiving
// is refused while meetings are still booked in the room (listed).
export async function setRoomArchived(roomId: number, archived: boolean, now?: Date) {
  return db.transaction(async (tx) => {
    const existing = await lockRoom(tx, roomId);

    if (archived && existing.archived_at) return existing;
    if (!archived && !existing.archived_at) return existing;

    if (archived) {
      const upcoming = await upcomingMeetings(tx, roomId, now);

      if (upcoming.length > 0) throw conflictError("archiving the room", upcoming);
    }

    const [updated] = await tx
      .update(room)
      .set({ archived_at: archived ? new Date() : null, updated_at: new Date() })
      .where(eq(room.room_id, roomId))
      .returning();

    return updated;
  });
}

export type RoomListItem = typeof room.$inferSelect & { statusCode: string | null };

// The rooms this person may see. Room managers see every room (archived ones
// too when asked); everyone else sees the active rooms their group may book
// (the same rule as the booking pages), so no room is offered to someone who
// could not book it.
export async function listRoomsFor(
  viewer: Viewer,
  options: { includeArchived?: boolean; facility?: string } = {}
): Promise<{ rooms: RoomListItem[]; canManage: boolean }> {
  const canManage = await canManageRooms(viewer.employeeId, viewer.role);

  const rows = await db
    .select({ room, statusCode: availabilityMaster.availabilityStatusCode })
    .from(room)
    .leftJoin(availabilityMaster, eq(availabilityMaster.availabilityStatusId, room.availabilityStatusId))
    .where(
      and(
        canManage && options.includeArchived ? undefined : isNull(room.archived_at),
        options.facility
          ? like(room.facilities, `%${escapeLike(options.facility)}%`)
          : undefined
      )
    )
    .orderBy(asc(room.room_name), asc(room.room_id));

  const rooms = rows.map((r) => ({ ...r.room, statusCode: r.statusCode }));

  if (canManage) return { rooms, canManage };

  const policy = await getBookingPolicy(viewer.employeeId);

  return { rooms: rooms.filter((r) => canUseRoom(policy, r.room_id)), canManage };
}
