import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/db";
import {
  employee,
  meeting,
  meeting_attendees,
  meetingTypes,
  roles,
  room,
  room_request_holders,
  room_requests,
} from "@/db/schema";
import { AVAILABILITY_STATUS, MEETING_STATUS, ROLE_ADMIN } from "@/lib/constants";
import { dbErrorCode, PG_UNIQUE_VIOLATION } from "@/lib/api";
import type { Tx } from "@/lib/db-types";
import { isSlotStartInPast, normalizeTime } from "@/lib/time";

import {
  BookingError,
  createBooking,
  SLOT_TAKEN_MESSAGE,
} from "./booking.service";
import { checkMeetingConflict } from "./conflict-check.service";
import { isMeetingTypeAllowedForRole } from "./meeting-type-access.service";
import { dispatchNotification } from "./notification.service";
import { cancelYielded, findSlotHolders } from "./priority.service";
import {
  dispatchRoomRequestEmails,
  processPendingRoomRequestEmails,
  queueRoomRequestEmail,
} from "./room-request-email.service";

// Room requests: an employee asks the organizer(s) of the booked meeting(s) in
// the way for a room. A request is NOT a booking. Nothing is booked, and no
// existing meeting is touched, until the room is actually free:
//
//   create      PENDING          every organizer whose meeting is in the way is
//                                e-mailed (one request can involve several
//                                meetings, and several organizers)
//   approve     each organizer decides on their own meeting(s). The request
//               goes ahead only when EVERY one has approved:
//                 room free       -> APPROVED, the requester's meeting is booked
//                 still occupied  -> AWAITING_SLOT (nothing booked yet)
//   release     an organizer explicitly cancels ONLY their own booking(s) for
//               that date (also offered together with approving)
//   slot freed  AWAITING_SLOT is booked automatically by the cron job once
//               every meeting in the way is gone
//   reject      any one organizer rejecting rejects the request
//   cancel      the requester takes it back
//   no result   EXPIRED once the requested slot starts
//
// The final booking and the status change happen in ONE transaction, serialised
// per room by createBooking's advisory lock and backed by the room-overlap
// EXCLUDE constraint, and a status guard (`UPDATE ... WHERE status IN (open)`)
// makes sure only one of several simultaneous decisions can win.

export class RoomRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RoomRequestError";
    this.status = status;
  }
}

export const OPEN_STATUSES = ["PENDING", "AWAITING_SLOT"] as const;

// More bookings than this in the way and it is simpler to pick another room.
export const MAX_REQUEST_HOLDERS = 5;

export const STATUS_LABEL: Record<string, string> = {
  PENDING: "Awaiting organizer response",
  AWAITING_SLOT: "Approved, waiting for the room to be released",
  APPROVED: "Approved and booked",
  REJECTED: "Request rejected",
  CANCELLED: "Request cancelled",
  EXPIRED: "Request expired",
  FAILED: "Approved, but could not be booked",
};

// Same per-room advisory lock namespace as booking.service.
const ROOM_LOCK_NAMESPACE = 7001;

const requesterEmployee = alias(employee, "requester_employee");
const holderOrganizer = alias(employee, "holder_organizer");

export type Viewer = { employeeId: number; role: string };

export type CreateRoomRequestInput = {
  requesterEmployeeId: number;
  requesterRole: string;
  roomId: number;
  meetingDate: string;
  startTime: string;
  endTime: string;
  title: string;
  message: string;
  participantCount: number;
  meetingTypeId: number;
  participantEmployeeIds?: number[];
  // Sent by the browser with each submit; a repeat returns the same request.
  clientRequestId?: string;
  now?: Date;
};

type RequestRow = typeof room_requests.$inferSelect;

/* ------------------------------ conflict info ----------------------------- */

export type ConflictBooking = {
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  organizerName: string;
  // Only for people who may see it (the organizer, attendees, Admins).
  title: string | null;
};

// Why a slot cannot be requested, so the screen can say it plainly instead of
// showing a generic "already booked".
export type ConflictCode =
  | "FREE" //              nothing is in the way: book it directly
  | "OWN_BOOKING" //       one of the bookings in the way is the viewer's own
  | "ALREADY_REQUESTED" // the viewer already has an open request for it
  | "TOO_MANY" //          more bookings than a request can cover
  | "STARTED" //           a meeting in the way has already started
  | "ROOM_UNAVAILABLE"
  | "NOT_FOUND";

export type ConflictDetails =
  | { requestable: true; bookings: ConflictBooking[] }
  | { requestable: false; reason: string; code: ConflictCode };

// Read-only description of what is in the way of a slot, for the booking
// screen. Only what the request needs is returned, and each title follows the
// app's existing rule (organizer, attendees and Admins only). Everything is
// re-checked, under lock, when a request is actually created.
export async function describeConflict(
  roomId: number,
  meetingDate: string,
  startTime: string,
  endTime: string,
  viewer: Viewer,
  now?: Date
): Promise<ConflictDetails> {
  const start = normalizeTime(startTime);
  const end = normalizeTime(endTime);

  const [roomRow] = await db.select().from(room).where(eq(room.room_id, roomId));

  if (!roomRow) {
    return { requestable: false, reason: "Room not found.", code: "NOT_FOUND" };
  }

  if (roomRow.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE) {
    return {
      requestable: false,
      reason: "This room is currently unavailable for booking.",
      code: "ROOM_UNAVAILABLE",
    };
  }

  const holders = await db
    .select({
      meetingId: meeting.meeting_id,
      title: meeting.title,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      organizerId: meeting.organizerEmployeeId,
      organizerName: employee.employee_name,
    })
    .from(meeting)
    .innerJoin(employee, eq(employee.employee_id, meeting.organizerEmployeeId))
    .where(
      and(
        eq(meeting.room_id, roomId),
        eq(meeting.meeting_date, meetingDate),
        ne(meeting.meetingStatusId, MEETING_STATUS.CANCELLED),
        sql`${meeting.start_time} < ${end}::time`,
        sql`${meeting.end_time} > ${start}::time`
      )
    )
    .orderBy(asc(meeting.start_time));

  if (holders.length === 0) {
    return {
      requestable: false,
      reason: "The room is free now. Try booking it again.",
      code: "FREE",
    };
  }

  if (holders.some((h) => h.organizerId === viewer.employeeId)) {
    return {
      requestable: false,
      reason:
        "You already have a booking in that room at that time. Cancel or move it first, or choose another time.",
      code: "OWN_BOOKING",
    };
  }

  const [alreadyAsked] = await db
    .select({ id: room_requests.room_request_id })
    .from(room_requests)
    .where(
      and(
        eq(room_requests.requester_employee_id, viewer.employeeId),
        eq(room_requests.room_id, roomId),
        eq(room_requests.meeting_date, meetingDate),
        inArray(room_requests.status, [...OPEN_STATUSES]),
        sql`${room_requests.start_time} < ${end}::time`,
        sql`${room_requests.end_time} > ${start}::time`
      )
    )
    .limit(1);

  if (alreadyAsked) {
    return {
      requestable: false,
      reason:
        "You have already requested this room for that time. Wait for the organizers to answer.",
      code: "ALREADY_REQUESTED",
    };
  }

  if (holders.length > MAX_REQUEST_HOLDERS) {
    return {
      requestable: false,
      reason: `${holders.length} bookings overlap that time, which is too many to request. Choose another room or time.`,
      code: "TOO_MANY",
    };
  }

  if (holders.some((h) => isSlotStartInPast(meetingDate, h.startTime, now))) {
    return {
      requestable: false,
      reason: "One of those meetings has already started and cannot be requested.",
      code: "STARTED",
    };
  }

  const attended =
    viewer.role === ROLE_ADMIN
      ? new Set(holders.map((h) => h.meetingId))
      : new Set(
          (
            await db
              .select({ meetingId: meeting_attendees.meeting_id })
              .from(meeting_attendees)
              .where(
                and(
                  inArray(
                    meeting_attendees.meeting_id,
                    holders.map((h) => h.meetingId)
                  ),
                  eq(meeting_attendees.employee_id, viewer.employeeId)
                )
              )
          ).map((a) => a.meetingId)
        );

  return {
    requestable: true,
    bookings: holders.map((h) => ({
      roomName: roomRow.room_name,
      meetingDate,
      startTime: h.startTime,
      endTime: h.endTime,
      organizerName: h.organizerName,
      title: attended.has(h.meetingId) ? h.title : null,
    })),
  };
}

/* --------------------------------- create --------------------------------- */

export async function createRoomRequest(input: CreateRoomRequestInput) {
  const startTime = normalizeTime(input.startTime);
  const endTime = normalizeTime(input.endTime);
  const message = input.message.trim();

  if (message.length === 0 || message.length > 1000) {
    throw new RoomRequestError(
      "Please explain why you need the room (1 to 1000 characters).",
      400
    );
  }

  if (startTime >= endTime) {
    throw new RoomRequestError("End time must be after start time", 400);
  }

  if (isSlotStartInPast(input.meetingDate, startTime, input.now)) {
    throw new RoomRequestError("Meetings cannot be booked in the past", 400);
  }

  const attendees = input.participantEmployeeIds ?? [];

  if (attendees.length > input.participantCount - 1) {
    throw new RoomRequestError(
      `You can add only ${input.participantCount - 1} attendee(s). The organizer is counted automatically.`,
      400
    );
  }

  const existingByClientId = async () => {
    if (!input.clientRequestId) return undefined;

    const [row] = await db
      .select()
      .from(room_requests)
      .where(
        and(
          eq(room_requests.requester_employee_id, input.requesterEmployeeId),
          eq(room_requests.client_request_id, input.clientRequestId)
        )
      );

    return row;
  };

  // A retry of the same submit: return what was already stored.
  const repeated = await existingByClientId();

  if (repeated) return { request: repeated, created: false };

  let created: { request: RequestRow; emailIds: (number | undefined)[] };

  try {
    created = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, ${input.roomId})`
      );

      const [roomDetails] = await tx
        .select()
        .from(room)
        .where(eq(room.room_id, input.roomId))
        .for("share");

      if (!roomDetails) throw new RoomRequestError("Room not found", 404);

      if (roomDetails.availabilityStatusId !== AVAILABILITY_STATUS.AVAILABLE) {
        throw new RoomRequestError(
          "This room is currently unavailable for booking.",
          409
        );
      }

      if (input.participantCount > roomDetails.room_capacity) {
        throw new RoomRequestError(
          `Room capacity exceeded. Room capacity is ${roomDetails.room_capacity}.`,
          400
        );
      }

      const [type] = await tx
        .select({ id: meetingTypes.meetingTypeId })
        .from(meetingTypes)
        .where(eq(meetingTypes.meetingTypeId, input.meetingTypeId));

      if (!type) throw new RoomRequestError("Meeting type not found", 404);

      if (
        !(await isMeetingTypeAllowedForRole(
          input.requesterRole,
          input.meetingTypeId,
          tx
        ))
      ) {
        throw new RoomRequestError(
          "Your role is not allowed to book this meeting type.",
          403
        );
      }

      if (attendees.length > 0) {
        const found = await tx
          .select({ id: employee.employee_id })
          .from(employee)
          .where(inArray(employee.employee_id, attendees));

        if (found.length !== new Set(attendees).size) {
          throw new RoomRequestError("One or more attendees not found", 404);
        }
      }

      // Every booked meeting in the way, locked for the rest of the transaction.
      const holders = await findSlotHolders(
        tx,
        input.roomId,
        [input.meetingDate],
        startTime,
        endTime
      );

      if (holders.length === 0) {
        throw new RoomRequestError(
          "This room is free for that time. Book it directly.",
          409
        );
      }

      if (holders.length > MAX_REQUEST_HOLDERS) {
        throw new RoomRequestError(
          `${holders.length} bookings overlap that time, which is too many to request. Choose another room or time.`,
          409
        );
      }

      if (holders.some((h) => h.organizerEmployeeId === input.requesterEmployeeId)) {
        throw new RoomRequestError(
          "One of the bookings in that room at that time is yours. Cancel or move it first, or choose another time.",
          409
        );
      }

      if (
        holders.some((h) => isSlotStartInPast(h.meetingDate, h.startTime, input.now))
      ) {
        throw new RoomRequestError(
          "One of those meetings has already started and cannot be requested.",
          409
        );
      }

      // One open request per person for the same room and time, whichever
      // meetings are in the way.
      const [open] = await tx
        .select({ id: room_requests.room_request_id })
        .from(room_requests)
        .where(
          and(
            eq(room_requests.requester_employee_id, input.requesterEmployeeId),
            eq(room_requests.room_id, input.roomId),
            eq(room_requests.meeting_date, input.meetingDate),
            inArray(room_requests.status, [...OPEN_STATUSES]),
            sql`${room_requests.start_time} < ${endTime}::time`,
            sql`${room_requests.end_time} > ${startTime}::time`
          )
        )
        .limit(1);

      if (open) {
        throw new RoomRequestError(
          "You have already asked for this room. Wait for the organizers to answer.",
          409
        );
      }

      // The earliest booking is the request's primary one; all of them are
      // recorded below, each with its own organizer's decision.
      const [primary] = holders;

      const [request] = await tx
        .insert(room_requests)
        .values({
          holder_meeting_id: primary.meetingId,
          holder_organizer_employee_id: primary.organizerEmployeeId,
          requester_employee_id: input.requesterEmployeeId,
          room_id: input.roomId,
          meeting_date: input.meetingDate,
          start_time: startTime,
          end_time: endTime,
          title: input.title,
          message,
          participant_count: input.participantCount,
          meeting_type_id: input.meetingTypeId,
          participant_employee_ids: attendees,
          client_request_id: input.clientRequestId ?? null,
        })
        .returning();

      await tx.insert(room_request_holders).values(
        holders.map((h) => ({
          room_request_id: request.room_request_id,
          holder_meeting_id: h.meetingId,
          organizer_employee_id: h.organizerEmployeeId,
        }))
      );

      // Saved first, mailed second: the e-mail intent commits with the request.
      // One mail per organizer, however many of their meetings are in the way.
      const emailIds: (number | undefined)[] = [];

      for (const organizerId of new Set(holders.map((h) => h.organizerEmployeeId))) {
        emailIds.push(
          await queueRoomRequestEmail(
            tx,
            request.room_request_id,
            "SUBMITTED",
            organizerId
          )
        );
      }

      return { request, emailIds };
    });
  } catch (error) {
    if (dbErrorCode(error) === PG_UNIQUE_VIOLATION) {
      // Two identical submits racing: the other one won.
      const winner = await existingByClientId();

      if (winner) return { request: winner, created: false };

      throw new RoomRequestError(
        "You have already asked for this room. Wait for the organizers to answer.",
        409
      );
    }

    throw error;
  }

  dispatchRoomRequestEmails(created.emailIds);

  return { request: created.request, created: true };
}

/* ------------------------------ shared helpers ---------------------------- */

type HolderRow = {
  holderId: number;
  meetingId: number;
  organizerId: number;
  status: string;
  meetingStatusId: number;
  meetingRoomId: number;
};

async function loadHolders(requestId: number): Promise<HolderRow[]> {
  return db
    .select({
      holderId: room_request_holders.room_request_holder_id,
      meetingId: room_request_holders.holder_meeting_id,
      organizerId: room_request_holders.organizer_employee_id,
      status: room_request_holders.status,
      meetingStatusId: meeting.meetingStatusId,
      meetingRoomId: meeting.room_id,
    })
    .from(room_request_holders)
    .innerJoin(meeting, eq(meeting.meeting_id, room_request_holders.holder_meeting_id))
    .where(eq(room_request_holders.room_request_id, requestId))
    .orderBy(asc(room_request_holders.room_request_holder_id));
}

// The booked meeting still sits in the requested room.
const holds = (h: HolderRow, request: RequestRow) =>
  h.meetingStatusId !== MEETING_STATUS.CANCELLED &&
  h.meetingRoomId === request.room_id;

async function loadRequest(requestId: number) {
  const [request] = await db
    .select()
    .from(room_requests)
    .where(eq(room_requests.room_request_id, requestId));

  return request;
}

// An organizer's view of a request: their holder rows, or "not found" (the same
// answer as a missing request, so IDs cannot be probed).
async function loadForOrganizer(requestId: number, organizerEmployeeId: number) {
  const request = await loadRequest(requestId);

  if (!request) throw new RoomRequestError("Request not found.", 404);

  const holders = await loadHolders(requestId);

  if (!holders.some((h) => h.organizerId === organizerEmployeeId)) {
    throw new RoomRequestError("Request not found.", 404);
  }

  return { request, holders };
}

const alreadyAnswered = () =>
  new RoomRequestError("This request was already answered.", 409);

// Cancels the organizer's own meetings (they chose to release them) and sends
// the usual cancellation e-mails.
async function releaseOwn(tx: Tx, meetingIds: number[], actorEmployeeId: number) {
  return cancelYielded(
    tx,
    meetingIds.map((meetingId) => ({ meetingId })),
    actorEmployeeId
  );
}

const dispatchMeetingNotifications = (ids: number[]) => {
  for (const id of ids) dispatchNotification(id);
};

/* -------------------------------- booking --------------------------------- */

type BookingOutcome = { outcome: "booked"; meetingId: number };

// Books the request's meeting and marks it APPROVED, atomically. `yieldMeetingIds`
// are meetings whose organizer agreed to give up their own booking in the same
// transaction; every other meeting in the way must already be gone.
async function bookRequest(
  request: RequestRow,
  decidedBy: number,
  { yieldMeetingIds, now }: { yieldMeetingIds: number[]; now?: Date }
): Promise<BookingOutcome> {
  const [requester] = await db
    .select({ role: roles.roleName })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(eq(employee.employee_id, request.requester_employee_id));

  if (!requester) {
    throw new BookingError("The requester no longer exists.", 404);
  }

  const emailIds: (number | undefined)[] = [];

  const booking = await createBooking({
    title: request.title,
    roomId: request.room_id,
    occurrenceDates: [request.meeting_date],
    startTime: request.start_time,
    endTime: request.end_time,
    // The requester, always read from the request row - never from the caller.
    organizerEmployeeId: request.requester_employee_id,
    // Their CURRENT role, not the one they had when asking.
    organizerRole: requester.role,
    participantCount: request.participant_count,
    meetingTypeId: request.meeting_type_id,
    participantEmployeeIds: request.participant_employee_ids,
    yieldMeetingIds,
    // An approval can only give up the organizers' own bookings; it must never
    // take the slot from anybody else, whatever the priorities.
    noBump: true,
    now,
    inTransaction: async (tx, meetings) => {
      // Only one decision can win, even with simultaneous clicks or a late
      // approval of something already rejected or cancelled.
      const [done] = await tx
        .update(room_requests)
        .set({
          status: "APPROVED",
          resulting_meeting_id: meetings[0].meeting_id,
          organizer_approved_at: sql`COALESCE(${room_requests.organizer_approved_at}, now())`,
          decided_by_employee_id: decidedBy,
          responded_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(room_requests.room_request_id, request.room_request_id),
            inArray(room_requests.status, [...OPEN_STATUSES])
          )
        )
        .returning({ id: room_requests.room_request_id });

      if (!done) throw alreadyAnswered();

      await tx
        .update(room_request_holders)
        .set({ status: "APPROVED", decided_at: new Date() })
        .where(
          and(
            eq(room_request_holders.room_request_id, request.room_request_id),
            eq(room_request_holders.status, "PENDING")
          )
        );

      emailIds.push(
        await queueRoomRequestEmail(
          tx,
          request.room_request_id,
          "APPROVED",
          request.requester_employee_id
        )
      );

      // The room now belongs to this request; anyone else waiting for the same
      // room and time is told no.
      const others = await tx
        .update(room_requests)
        .set({
          status: "REJECTED",
          rejection_reason: "The room was given to another request.",
          decided_by_employee_id: decidedBy,
          responded_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(room_requests.room_id, request.room_id),
            eq(room_requests.meeting_date, request.meeting_date),
            inArray(room_requests.status, [...OPEN_STATUSES]),
            ne(room_requests.room_request_id, request.room_request_id),
            sql`${room_requests.start_time} < ${request.end_time}::time`,
            sql`${room_requests.end_time} > ${request.start_time}::time`
          )
        )
        .returning({
          id: room_requests.room_request_id,
          requesterId: room_requests.requester_employee_id,
        });

      for (const o of others) {
        emailIds.push(
          await queueRoomRequestEmail(tx, o.id, "REJECTED", o.requesterId)
        );
      }
    },
  });

  dispatchRoomRequestEmails(emailIds);

  // The cancellation e-mails of the meetings that were given up.
  dispatchMeetingNotifications(booking.otherNotificationIds);

  return { outcome: "booked", meetingId: booking.meetings[0].meeting_id };
}

const isSlotTaken = (error: unknown) =>
  error instanceof BookingError && error.message === SLOT_TAKEN_MESSAGE;

async function expireOne(requestId: number, requesterEmployeeId: number) {
  const emailId = await db.transaction(async (tx) => {
    const [done] = await tx
      .update(room_requests)
      .set({
        status: "EXPIRED",
        responded_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(room_requests.room_request_id, requestId),
          inArray(room_requests.status, [...OPEN_STATUSES])
        )
      )
      .returning({ id: room_requests.room_request_id });

    return done
      ? queueRoomRequestEmail(tx, requestId, "EXPIRED", requesterEmployeeId)
      : undefined;
  });

  dispatchRoomRequestEmails([emailId]);

  return emailId !== undefined;
}

// Everybody agreed but the booking was refused (room out of service, role no
// longer allowed...): close the request and tell the requester.
async function markFailed(requestId: number, requesterEmployeeId: number) {
  const emailId = await db.transaction(async (tx) => {
    const [done] = await tx
      .update(room_requests)
      .set({
        status: "FAILED",
        responded_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(room_requests.room_request_id, requestId),
          inArray(room_requests.status, [...OPEN_STATUSES])
        )
      )
      .returning({ id: room_requests.room_request_id });

    return done
      ? queueRoomRequestEmail(tx, requestId, "FAILED", requesterEmployeeId)
      : undefined;
  });

  dispatchRoomRequestEmails([emailId]);
}

export type ApproveOutcome =
  | { outcome: "booked"; meetingId: number }
  // Everyone agreed, but a booking still holds the room: nothing booked.
  | { outcome: "awaiting_slot" }
  // This organizer agreed; other organizers have not answered yet.
  | { outcome: "waiting_others" }
  // Everyone agreed but the booking was refused. Nothing was booked.
  | { outcome: "failed"; message: string };

// Looks at where a request stands after a decision and moves it on. Safe to
// run more than once and from several places at the same time.
async function advance(
  request: RequestRow,
  actorEmployeeId: number,
  now?: Date
): Promise<ApproveOutcome> {
  const fresh = (await loadRequest(request.room_request_id)) ?? request;

  if (fresh.status === "APPROVED") {
    return { outcome: "booked", meetingId: fresh.resulting_meeting_id ?? 0 };
  }

  if (!OPEN_STATUSES.includes(fresh.status as (typeof OPEN_STATUSES)[number])) {
    throw alreadyAnswered();
  }

  const holders = await loadHolders(fresh.room_request_id);

  if (holders.some((h) => h.status !== "APPROVED")) {
    return { outcome: "waiting_others" };
  }

  // Everyone agreed. Book if the room is free.
  const occupied = await checkMeetingConflict(
    fresh.room_id,
    fresh.meeting_date,
    fresh.start_time,
    fresh.end_time
  );

  if (!occupied) {
    try {
      return await bookRequest(fresh, actorEmployeeId, {
        yieldMeetingIds: [],
        now,
      });
    } catch (error) {
      if (error instanceof RoomRequestError) throw error;

      if (error instanceof BookingError && !isSlotTaken(error)) {
        await markFailed(fresh.room_request_id, fresh.requester_employee_id);

        return { outcome: "failed", message: error.message };
      }

      if (!isSlotTaken(error)) throw error;
      // Taken a moment ago: treat as occupied below.
    }
  }

  // Occupied: record that it is waiting for the room, and say who must act.
  if (fresh.status === "PENDING") {
    const emailIds = await db.transaction(async (tx) => {
      const [moved] = await tx
        .update(room_requests)
        .set({
          status: "AWAITING_SLOT",
          organizer_approved_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(room_requests.room_request_id, fresh.room_request_id),
            eq(room_requests.status, "PENDING")
          )
        )
        .returning({ id: room_requests.room_request_id });

      if (!moved) return []; // another decision got here first

      const ids: (number | undefined)[] = [];

      for (const organizerId of new Set(
        holders.filter((h) => holds(h, fresh)).map((h) => h.organizerId)
      )) {
        ids.push(
          await queueRoomRequestEmail(
            tx,
            fresh.room_request_id,
            "AWAITING_RELEASE",
            organizerId
          )
        );
      }

      ids.push(
        await queueRoomRequestEmail(
          tx,
          fresh.room_request_id,
          "APPROVAL_PENDING",
          fresh.requester_employee_id
        )
      );

      return ids;
    });

    dispatchRoomRequestEmails(emailIds);
  }

  return { outcome: "awaiting_slot" };
}

/* -------------------------------- decisions ------------------------------- */

// An organizer approves their meeting(s). The request goes ahead only when every
// organizer in the way has approved. Their own booking is cancelled ONLY if
// they pass `releaseBooking` (their explicit choice, for that date only).
export async function approveRoomRequest(
  requestId: number,
  organizerEmployeeId: number,
  { releaseBooking = false, now }: { releaseBooking?: boolean; now?: Date } = {}
): Promise<ApproveOutcome> {
  const { request, holders } = await loadForOrganizer(requestId, organizerEmployeeId);

  if (request.status !== "PENDING") throw alreadyAnswered();

  const mine = holders.filter((h) => h.organizerId === organizerEmployeeId);

  // Already answered for all of their meetings: no repeat, no change of mind.
  if (!mine.some((h) => h.status === "PENDING")) throw alreadyAnswered();

  if (isSlotStartInPast(request.meeting_date, request.start_time, now)) {
    await expireOne(requestId, request.requester_employee_id);
    throw new RoomRequestError(
      "The requested time has already started, so the request expired.",
      409
    );
  }

  const others = holders.filter((h) => h.organizerId !== organizerEmployeeId);
  const myHoldingIds = mine.filter((h) => holds(h, request)).map((h) => h.meetingId);
  const othersReady =
    others.every((h) => h.status === "APPROVED") &&
    others.every((h) => !holds(h, request));

  // This approval completes everything and nothing else is in the way: release
  // and book in ONE transaction, so a refused booking leaves their meeting alone.
  if (releaseBooking && othersReady) {
    try {
      return await bookRequest(request, organizerEmployeeId, {
        yieldMeetingIds: myHoldingIds,
        now,
      });
    } catch (error) {
      if (!isSlotTaken(error)) throw error;
      // Something else took the room: fall back to recording the decision.
    }
  }

  const notificationIds = await db.transaction(async (tx) => {
    const marked = await tx
      .update(room_request_holders)
      .set({ status: "APPROVED", decided_at: new Date() })
      .where(
        and(
          eq(room_request_holders.room_request_id, requestId),
          eq(room_request_holders.organizer_employee_id, organizerEmployeeId),
          eq(room_request_holders.status, "PENDING")
        )
      )
      .returning({ id: room_request_holders.room_request_holder_id });

    // Guard against a decision that landed in the meantime.
    const [still] = await tx
      .select({ status: room_requests.status })
      .from(room_requests)
      .where(eq(room_requests.room_request_id, requestId))
      .for("update");

    if (marked.length === 0 || still?.status !== "PENDING") throw alreadyAnswered();

    return releaseBooking && myHoldingIds.length > 0
      ? releaseOwn(tx, myHoldingIds, organizerEmployeeId)
      : [];
  });

  dispatchMeetingNotifications(notificationIds);

  return advance(request, organizerEmployeeId, now);
}

// An organizer explicitly gives up their own booking(s) for this date to help a
// request they already approved along.
export async function releaseAndBook(
  requestId: number,
  organizerEmployeeId: number,
  now?: Date
): Promise<ApproveOutcome> {
  const { request, holders } = await loadForOrganizer(requestId, organizerEmployeeId);

  if (!OPEN_STATUSES.includes(request.status as (typeof OPEN_STATUSES)[number])) {
    throw alreadyAnswered();
  }

  const mine = holders.filter((h) => h.organizerId === organizerEmployeeId);

  // Only for what they approved: release is the second half of "yes", never a
  // way to skip the decision.
  if (!mine.every((h) => h.status === "APPROVED")) {
    throw new RoomRequestError("Approve the request first.", 409);
  }

  const myHoldingIds = mine.filter((h) => holds(h, request)).map((h) => h.meetingId);

  if (myHoldingIds.length === 0) {
    throw new RoomRequestError("None of your bookings holds that room any more.", 409);
  }

  if (isSlotStartInPast(request.meeting_date, request.start_time, now)) {
    await expireOne(requestId, request.requester_employee_id);
    throw new RoomRequestError(
      "The requested time has already started, so the request expired.",
      409
    );
  }

  const othersHolding = holders.some(
    (h) => h.organizerId !== organizerEmployeeId && holds(h, request)
  );
  const othersAllApproved = holders
    .filter((h) => h.organizerId !== organizerEmployeeId)
    .every((h) => h.status === "APPROVED");

  // Everyone agreed and their meeting is the last thing in the way: release and
  // book together.
  if (!othersHolding && othersAllApproved) {
    try {
      return await bookRequest(request, organizerEmployeeId, {
        yieldMeetingIds: myHoldingIds,
        now,
      });
    } catch (error) {
      if (!isSlotTaken(error)) throw error;
    }
  }

  const notificationIds = await db.transaction((tx) =>
    releaseOwn(tx, myHoldingIds, organizerEmployeeId)
  );

  dispatchMeetingNotifications(notificationIds);

  return advance(request, organizerEmployeeId, now);
}

// Any one organizer rejecting rejects the request.
export async function rejectRoomRequest(
  requestId: number,
  organizerEmployeeId: number,
  reason?: string
) {
  const { request, holders } = await loadForOrganizer(requestId, organizerEmployeeId);

  // Once approved (even waiting for the room) it cannot be rejected: no
  // contradictory decisions.
  if (request.status !== "PENDING") throw alreadyAnswered();

  const mine = holders.filter((h) => h.organizerId === organizerEmployeeId);

  if (!mine.some((h) => h.status === "PENDING")) throw alreadyAnswered();

  const trimmed = reason?.trim() || null;

  if (trimmed && trimmed.length > 500) {
    throw new RoomRequestError("The reason is too long (500 characters).", 400);
  }

  const emailId = await db.transaction(async (tx) => {
    const [done] = await tx
      .update(room_requests)
      .set({
        status: "REJECTED",
        rejection_reason: trimmed,
        decided_by_employee_id: organizerEmployeeId,
        responded_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(room_requests.room_request_id, requestId),
          eq(room_requests.status, "PENDING")
        )
      )
      .returning({ id: room_requests.room_request_id });

    if (!done) throw alreadyAnswered();

    await tx
      .update(room_request_holders)
      .set({ status: "REJECTED", decided_at: new Date() })
      .where(
        and(
          eq(room_request_holders.room_request_id, requestId),
          eq(room_request_holders.organizer_employee_id, organizerEmployeeId),
          eq(room_request_holders.status, "PENDING")
        )
      );

    return queueRoomRequestEmail(
      tx,
      requestId,
      "REJECTED",
      request.requester_employee_id
    );
  });

  dispatchRoomRequestEmails([emailId]);
}

// The requester takes the request back.
export async function cancelRoomRequest(
  requestId: number,
  requesterEmployeeId: number
) {
  const request = await loadRequest(requestId);

  // Someone else's request looks the same as a missing one.
  if (!request || request.requester_employee_id !== requesterEmployeeId) {
    throw new RoomRequestError("Request not found.", 404);
  }

  const emailIds = await db.transaction(async (tx) => {
    const [done] = await tx
      .update(room_requests)
      .set({
        status: "CANCELLED",
        decided_by_employee_id: requesterEmployeeId,
        responded_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(room_requests.room_request_id, requestId),
          inArray(room_requests.status, [...OPEN_STATUSES])
        )
      )
      .returning({ id: room_requests.room_request_id });

    if (!done) throw alreadyAnswered();

    const organizers = await tx
      .selectDistinct({ id: room_request_holders.organizer_employee_id })
      .from(room_request_holders)
      .where(eq(room_request_holders.room_request_id, requestId));

    const ids: (number | undefined)[] = [];

    for (const o of organizers) {
      ids.push(await queueRoomRequestEmail(tx, requestId, "CANCELLED", o.id));
    }

    return ids;
  });

  dispatchRoomRequestEmails(emailIds);
}

/* --------------------------- background processing ------------------------ */

// Expires open requests whose slot has started. Safe from several instances:
// each update only succeeds for a row that is still open.
export async function expireRoomRequests(now: Date = new Date()) {
  const open = await db
    .select({
      id: room_requests.room_request_id,
      requesterId: room_requests.requester_employee_id,
      meetingDate: room_requests.meeting_date,
      startTime: room_requests.start_time,
    })
    .from(room_requests)
    .where(inArray(room_requests.status, [...OPEN_STATUSES]));

  let expired = 0;

  for (const r of open) {
    if (!isSlotStartInPast(r.meetingDate, r.startTime, now)) continue;

    if (await expireOne(r.id, r.requesterId)) expired++;
  }

  return expired;
}

// Completes approved requests whose room has become free (organizers cancelled
// their meetings, or they were moved by a priority booking). Earliest approval
// first. Only a free slot is ever booked: a still-occupied one just keeps
// waiting.
export async function fulfilAwaitingRequests(now: Date = new Date()) {
  const waiting = await db
    .select()
    .from(room_requests)
    .where(eq(room_requests.status, "AWAITING_SLOT"))
    .orderBy(
      asc(room_requests.organizer_approved_at),
      asc(room_requests.room_request_id)
    );

  let booked = 0;

  for (const request of waiting) {
    if (isSlotStartInPast(request.meeting_date, request.start_time, now)) {
      continue; // expireRoomRequests handles it
    }

    const occupied = await checkMeetingConflict(
      request.room_id,
      request.meeting_date,
      request.start_time,
      request.end_time
    );

    if (occupied) continue;

    try {
      await bookRequest(request, request.holder_organizer_employee_id, {
        yieldMeetingIds: [],
        now,
      });
      booked++;
    } catch (error) {
      if (error instanceof RoomRequestError) continue; // answered meanwhile

      // Taken a moment ago, or a collision: keep waiting.
      if (isSlotTaken(error)) continue;

      if (error instanceof BookingError) {
        if (error.status === 409 && !/unavailable/i.test(error.message)) continue;

        // The room is free but the booking is refused: it cannot be completed.
        await markFailed(request.room_request_id, request.requester_employee_id);
        continue;
      }

      console.error(
        `Room request ${request.room_request_id} could not be completed:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return booked;
}

// One cron pass: expire, complete what became possible, retry e-mail.
export async function processRoomRequests(now: Date = new Date()) {
  const expired = await expireRoomRequests(now);
  const booked = await fulfilAwaitingRequests(now);
  const emails = await processPendingRoomRequestEmails();

  return { expired, booked, emails };
}

/* ---------------------------------- reads --------------------------------- */

// Requests the employee has received (they organize at least one booked
// meeting in the way) and sent.
export async function listRoomRequests(employeeId: number) {
  const mineAsOrganizer = db
    .select({ id: room_request_holders.room_request_id })
    .from(room_request_holders)
    .where(eq(room_request_holders.organizer_employee_id, employeeId));

  const rows = await db
    .select({
      requestId: room_requests.room_request_id,
      status: room_requests.status,
      title: room_requests.title,
      meetingDate: room_requests.meeting_date,
      startTime: room_requests.start_time,
      endTime: room_requests.end_time,
      roomName: room.room_name,
      createdAt: room_requests.created_at,
      rejectionReason: room_requests.rejection_reason,
      resultingMeetingId: room_requests.resulting_meeting_id,
      requesterId: room_requests.requester_employee_id,
      requesterName: requesterEmployee.employee_name,
      organizerNames: sql<string>`(
        SELECT string_agg(DISTINCT e.employee_name, ', ')
        FROM room_request_holders h
        JOIN "Employee" e ON e.employee_id = h.organizer_employee_id
        WHERE h.room_request_id = ${room_requests.room_request_id}
      )`,
      isMine: sql<boolean>`${room_requests.room_request_id} IN (${mineAsOrganizer})`,
    })
    .from(room_requests)
    .innerJoin(room, eq(room.room_id, room_requests.room_id))
    .innerJoin(
      requesterEmployee,
      eq(requesterEmployee.employee_id, room_requests.requester_employee_id)
    )
    .where(
      or(
        eq(room_requests.requester_employee_id, employeeId),
        inArray(room_requests.room_request_id, mineAsOrganizer)
      )
    )
    .orderBy(desc(room_requests.room_request_id));

  return {
    received: rows.filter((r) => r.isMine),
    sent: rows.filter((r) => r.requesterId === employeeId),
  };
}

export type RoomRequestHolderView = {
  meetingId: number;
  organizerName: string;
  status: string;
  own: boolean;
  // Only the viewer's own meetings show their title and time.
  title: string | null;
  startTime: string | null;
  endTime: string | null;
  holdsRoom: boolean;
};

// One request, only for its requester or an organizer of a booked meeting in
// the way; anybody else (Admins included) gets null, the same as a missing
// request.
export async function getRoomRequestFor(requestId: number, viewerEmployeeId: number) {
  const [row] = await db
    .select({
      requestId: room_requests.room_request_id,
      status: room_requests.status,
      title: room_requests.title,
      message: room_requests.message,
      rejectionReason: room_requests.rejection_reason,
      meetingDate: room_requests.meeting_date,
      startTime: room_requests.start_time,
      endTime: room_requests.end_time,
      createdAt: room_requests.created_at,
      respondedAt: room_requests.responded_at,
      resultingMeetingId: room_requests.resulting_meeting_id,
      roomName: room.room_name,
      roomId: room_requests.room_id,
      requesterId: room_requests.requester_employee_id,
      requesterName: requesterEmployee.employee_name,
      requesterEmail: requesterEmployee.email,
    })
    .from(room_requests)
    .innerJoin(room, eq(room.room_id, room_requests.room_id))
    .innerJoin(
      requesterEmployee,
      eq(requesterEmployee.employee_id, room_requests.requester_employee_id)
    )
    .where(eq(room_requests.room_request_id, requestId));

  if (!row) return null;

  const holderRows = await db
    .select({
      meetingId: room_request_holders.holder_meeting_id,
      organizerId: room_request_holders.organizer_employee_id,
      organizerName: holderOrganizer.employee_name,
      status: room_request_holders.status,
      title: meeting.title,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      meetingStatusId: meeting.meetingStatusId,
      meetingRoomId: meeting.room_id,
    })
    .from(room_request_holders)
    .innerJoin(meeting, eq(meeting.meeting_id, room_request_holders.holder_meeting_id))
    .innerJoin(
      holderOrganizer,
      eq(holderOrganizer.employee_id, room_request_holders.organizer_employee_id)
    )
    .where(eq(room_request_holders.room_request_id, requestId))
    .orderBy(asc(meeting.start_time));

  const viewerIsOrganizer = holderRows.some((h) => h.organizerId === viewerEmployeeId);
  const viewerIsRequester = row.requesterId === viewerEmployeeId;

  if (!viewerIsOrganizer && !viewerIsRequester) return null;

  const holders: RoomRequestHolderView[] = holderRows.map((h) => {
    const own = h.organizerId === viewerEmployeeId;

    return {
      meetingId: h.meetingId,
      organizerName: h.organizerName,
      status: h.status,
      own,
      title: own ? h.title : null,
      startTime: own ? h.startTime : null,
      endTime: own ? h.endTime : null,
      holdsRoom:
        h.meetingStatusId !== MEETING_STATUS.CANCELLED &&
        h.meetingRoomId === row.roomId,
    };
  });

  const mine = holders.filter((h) => h.own);
  const open = (OPEN_STATUSES as readonly string[]).includes(row.status);

  return {
    ...row,
    holders,
    viewerIsOrganizer,
    viewerIsRequester,
    // What the viewer, as an organizer, can still do:
    canDecide:
      viewerIsOrganizer &&
      row.status === "PENDING" &&
      mine.some((h) => h.status === "PENDING"),
    canRelease:
      viewerIsOrganizer &&
      open &&
      mine.every((h) => h.status === "APPROVED") &&
      mine.some((h) => h.holdsRoom),
    canCancel: viewerIsRequester && open,
  };
}

export type RoomRequestDetail = NonNullable<
  Awaited<ReturnType<typeof getRoomRequestFor>>
>;

// Rooms that are in service and big enough but taken for the slot. The picker
// lists them (marked) so a user can still choose one and, at confirmation, be
// offered a request.
export async function getOccupiedRooms(
  meetingDate: string,
  startTime: string,
  endTime: string,
  participantCount: number,
  excludeRoomIds: number[]
) {
  const occupied = await getOccupiedRoomIds(meetingDate, startTime, endTime);

  const rooms = await db
    .select()
    .from(room)
    .where(eq(room.availabilityStatusId, AVAILABILITY_STATUS.AVAILABLE))
    .orderBy(asc(room.room_id));

  return rooms.filter(
    (r) =>
      occupied.has(r.room_id) &&
      !excludeRoomIds.includes(r.room_id) &&
      r.room_capacity >= participantCount
  );
}

export async function getOccupiedRoomIds(
  meetingDate: string,
  startTime: string,
  endTime: string,
  executor: Tx | typeof db = db
) {
  const rows = await executor
    .select({ roomId: meeting.room_id })
    .from(meeting)
    .where(
      and(
        eq(meeting.meeting_date, meetingDate),
        ne(meeting.meetingStatusId, MEETING_STATUS.CANCELLED),
        sql`${meeting.start_time} < ${normalizeTime(endTime)}::time`,
        sql`${meeting.end_time} > ${normalizeTime(startTime)}::time`
      )
    );

  return new Set(rows.map((r) => r.roomId));
}
