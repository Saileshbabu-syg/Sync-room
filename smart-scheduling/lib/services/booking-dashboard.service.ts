import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { db } from "@/db";
import {
  employee,
  groups,
  meeting,
  meeting_attendees,
  meetingStatuses,
  meetingTypes,
  room,
} from "@/db/schema";
import { MEETING_STATUS, MEETING_STATUS_LABEL } from "@/lib/constants";
import type { Period } from "@/lib/report-period";

import {
  getBumpInfo,
  getReplacedBookings,
  type BumpInfo,
  type ReplacedBooking,
} from "./bump-info.service";
import { meetingEndsAt, meetingStartsAt } from "./conflict-check.service";

// Read-only booking history for the booking dashboard and its report downloads.
// The metrics, the table and the exports all build their WHERE clause with
// buildWhere(), so a report always contains exactly the records on screen.
//
// Bumped (preempted) bookings are listed like any other, with a "Bumped" status
// and, in the expanded row, who took their room. They never count as Confirmed,
// so they add no meeting hours and no active rooms.
//
// Definitions:
//  * Confirmed   = Scheduled + Completed (the booking held its slot).
//  * Meeting hours = total duration of Confirmed bookings.
//  * Active rooms  = distinct rooms with at least one Confirmed booking.
// Priority and group come from the snapshot stored with each booking, so they
// show the standing used at booking time, not the organizer's current one.

export type DashboardFilters = {
  period: Period;
  groupId?: number;
  roomId?: number;
  statusId?: number;
  // Matches organizer name, organizer e-mail or meeting title.
  search?: string;
  sort?: "asc" | "desc";
};

// Statuses the dashboard can show or filter by.
export const VALID_STATUS_IDS = Object.keys(MEETING_STATUS_LABEL).map(Number);

const CONFIRMED = [MEETING_STATUS.SCHEDULED, MEETING_STATUS.COMPLETED];

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildWhere(f: DashboardFilters) {
  const term = f.search?.trim();

  return and(
    gte(meeting.meeting_date, f.period.start),
    lte(meeting.meeting_date, f.period.end),
    f.groupId !== undefined
      ? eq(meeting.groupIdAtBooking, f.groupId)
      : undefined,
    f.roomId !== undefined ? eq(meeting.room_id, f.roomId) : undefined,
    f.statusId !== undefined
      ? eq(meeting.meetingStatusId, f.statusId)
      : undefined,
    term
      ? or(
          ilike(employee.employee_name, `%${escapeLike(term)}%`),
          ilike(employee.email, `%${escapeLike(term)}%`),
          ilike(meeting.title, `%${escapeLike(term)}%`)
        )
      : undefined
  );
}

export type DashboardMetrics = {
  totalBookings: number;
  confirmedBookings: number;
  cancelledBookings: number;
  bumpedBookings: number;
  // Waiting for their organizer to pick another room or time.
  pendingBookings: number;
  totalMeetingHours: number;
  activeRooms: number;
};

export async function getDashboardMetrics(
  f: DashboardFilters
): Promise<DashboardMetrics> {
  const confirmed = sql`${meeting.meetingStatusId} in (${sql.join(
    CONFIRMED.map((id) => sql`${id}`),
    sql`, `
  )})`;

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      confirmed: sql<number>`(count(*) filter (where ${confirmed}))::int`,
      cancelled: sql<number>`(count(*) filter (where ${meeting.meetingStatusId} = ${MEETING_STATUS.CANCELLED}))::int`,
      bumped: sql<number>`(count(*) filter (where ${meeting.meetingStatusId} = ${MEETING_STATUS.PREEMPTED}))::int`,
      pending: sql<number>`(count(*) filter (where ${meeting.meetingStatusId} = ${MEETING_STATUS.PENDING_RESCHEDULE}))::int`,
      hours: sql<string>`coalesce(sum(extract(epoch from (${meetingEndsAt} - ${meetingStartsAt})) / 3600.0) filter (where ${confirmed}), 0)::text`,
      rooms: sql<number>`(count(distinct ${meeting.room_id}) filter (where ${confirmed}))::int`,
    })
    .from(meeting)
    .innerJoin(employee, eq(employee.employee_id, meeting.organizerEmployeeId))
    .where(buildWhere(f));

  return {
    totalBookings: row.total,
    confirmedBookings: row.confirmed,
    cancelledBookings: row.cancelled,
    bumpedBookings: row.bumped,
    pendingBookings: row.pending,
    totalMeetingHours: Math.round(Number(row.hours) * 100) / 100,
    activeRooms: row.rooms,
  };
}

export type ParticipantRow = {
  employeeId: number;
  name: string;
  email: string;
  // ACCEPTED | DECLINED | NO_RESPONSE
  response: string;
  isOptional: boolean;
};

export type DashboardBookingRow = {
  bookingId: number;
  organizerName: string;
  organizerEmail: string;
  groupName: string | null;
  priorityAtBooking: number | null;
  meetingType: string;
  title: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  statusId: number;
  status: string;
  // Filled by listDashboardBookings (the export does not need them).
  participants: ParticipantRow[];
  // Set for a replaced booking: who took the room and why, with the people
  // invited to the replacement meeting.
  bumped: (BumpInfo & { participants: ParticipantRow[] }) | null;
  // Set for a booking that took a room: the bookings it replaced, each with
  // their invited people.
  replaced: (ReplacedBooking & { participants: ParticipantRow[] })[];
};

// A booking row without the parts that are loaded separately.
export type DashboardBookingBase = Omit<
  DashboardBookingRow,
  "participants" | "bumped" | "replaced"
>;

function queryPage(f: DashboardFilters, limit: number, offset: number) {
  const direction = f.sort === "asc" ? asc : desc;

  return db
    .select({
      bookingId: meeting.meeting_id,
      organizerName: employee.employee_name,
      organizerEmail: employee.email,
      groupName: groups.name,
      priorityAtBooking: meeting.priorityAtBooking,
      meetingType: meetingTypes.meetingTypeName,
      title: meeting.title,
      roomName: room.room_name,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      statusId: meeting.meetingStatusId,
      statusName: meetingStatuses.meetingStatusName,
    })
    .from(meeting)
    .innerJoin(employee, eq(employee.employee_id, meeting.organizerEmployeeId))
    .innerJoin(room, eq(room.room_id, meeting.room_id))
    .innerJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, meeting.meetingTypeId)
    )
    .innerJoin(
      meetingStatuses,
      eq(meetingStatuses.meetingStatusId, meeting.meetingStatusId)
    )
    .leftJoin(groups, eq(groups.id, meeting.groupIdAtBooking))
    .where(buildWhere(f))
    // meeting_id makes the order total, so paging and exports never skip or
    // repeat a row.
    .orderBy(
      direction(meeting.meeting_date),
      direction(meeting.start_time),
      direction(meeting.meeting_id)
    )
    .limit(limit)
    .offset(offset);
}

type RawRow = Awaited<ReturnType<typeof queryPage>>[number];

function toRow({
  statusName,
  ...r
}: RawRow): DashboardBookingBase {
  return {
    ...r,
    // Label from the status id, like the rest of the app.
    status: MEETING_STATUS_LABEL[r.statusId] ?? statusName ?? "Unknown",
  };
}

// The people invited to each meeting (the organizer is the first, ACCEPTED).
async function participantsOf(meetingIds: number[]) {
  const byMeeting = new Map<number, ParticipantRow[]>();

  if (meetingIds.length === 0) return byMeeting;

  const rows = await db
    .select({
      meetingId: meeting_attendees.meeting_id,
      employeeId: employee.employee_id,
      name: employee.employee_name,
      email: employee.email,
      response: meeting_attendees.response_status,
      isOptional: meeting_attendees.is_optional,
      organizerId: meeting.organizerEmployeeId,
    })
    .from(meeting_attendees)
    .innerJoin(
      employee,
      eq(employee.employee_id, meeting_attendees.employee_id)
    )
    .innerJoin(meeting, eq(meeting.meeting_id, meeting_attendees.meeting_id))
    .where(inArray(meeting_attendees.meeting_id, meetingIds))
    .orderBy(
      asc(meeting_attendees.is_optional),
      asc(employee.employee_name)
    );

  for (const { meetingId, organizerId, ...p } of rows) {
    // The organizer is shown as the organizer, not as a participant.
    if (p.employeeId === organizerId) continue;

    byMeeting.set(meetingId, [...(byMeeting.get(meetingId) ?? []), p]);
  }

  return byMeeting;
}

export async function listDashboardBookings(
  f: DashboardFilters,
  page: number,
  pageSize: number
) {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(meeting)
    .innerJoin(employee, eq(employee.employee_id, meeting.organizerEmployeeId))
    .where(buildWhere(f));

  const rows = (await queryPage(f, pageSize, (page - 1) * pageSize)).map(toRow);
  const ids = rows.map((r) => r.bookingId);
  const [bumps, replacedBy] = await Promise.all([
    getBumpInfo(
      rows.filter((r) => r.statusId === MEETING_STATUS.PREEMPTED).map((r) => r.bookingId)
    ),
    getReplacedBookings(ids),
  ]);

  // The people invited to every meeting involved: the listed ones, the meetings
  // that replaced them and the meetings they replaced.
  const related = new Set(ids);

  for (const b of bumps.values()) related.add(b.byBookingId);
  for (const list of replacedBy.values()) for (const o of list) related.add(o.bookingId);

  const participants = await participantsOf([...related]);

  return {
    total,
    rows: rows.map((r) => {
      const bump = bumps.get(r.bookingId);

      return {
        ...r,
        participants: participants.get(r.bookingId) ?? [],
        bumped: bump
          ? { ...bump, participants: participants.get(bump.byBookingId) ?? [] }
          : null,
        replaced: (replacedBy.get(r.bookingId) ?? []).map((o) => ({
          ...o,
          participants: participants.get(o.bookingId) ?? [],
        })),
      };
    }),
  };
}

// Every matching booking, fetched in fixed-size pages so a report never holds
// the whole result in memory.
export async function* iterateDashboardBookings(
  f: DashboardFilters,
  batchSize = 1000
): AsyncGenerator<
  DashboardBookingBase & { bumped: BumpInfo | null; participants: ParticipantRow[] }
> {
  for (let offset = 0; ; offset += batchSize) {
    const batch = (await queryPage(f, batchSize, offset)).map(toRow);
    const [bumps, participants] = await Promise.all([
      getBumpInfo(
        batch.filter((r) => r.statusId === MEETING_STATUS.PREEMPTED).map((r) => r.bookingId)
      ),
      participantsOf(batch.map((r) => r.bookingId)),
    ]);

    // Each booking carries its own invitees (organizer excluded), so a report
    // can list them under the meeting exactly like the dashboard does.
    for (const row of batch) {
      yield {
        ...row,
        bumped: bumps.get(row.bookingId) ?? null,
        participants: participants.get(row.bookingId) ?? [],
      };
    }

    if (batch.length < batchSize) return;
  }
}
