import { db } from "@/db";
import {
  meeting,
  meeting_attendees,
  meetingStatuses,
  meetingTypes,
  room,
} from "@/db/schema";
import { and, desc, eq, exists, inArray, or, sql } from "drizzle-orm";

import { MEETING_STATUS } from "@/lib/constants";

// A meeting belongs to an employee when they organize it or were added to it
// as a participant (a persisted meeting_attendees row; every occurrence of a
// recurring series has its own meeting row and its own attendee rows).
// `employeeId` must come from the authenticated session, never from a request.
export function involvesEmployee(employeeId: number) {
  return or(
    eq(meeting.organizerEmployeeId, employeeId),
    exists(
      db
        .select({ one: sql`1` })
        .from(meeting_attendees)
        .where(
          and(
            eq(meeting_attendees.meeting_id, meeting.meeting_id),
            eq(meeting_attendees.employee_id, employeeId)
          )
        )
    )
  );
}

// The My Bookings tabs. The keys are stable ids (they appear in the URL and
// key the tabs); what each tab holds is defined by status ids, never by the
// labels shown.
export const BOOKING_TABS = {
  scheduled: [MEETING_STATUS.SCHEDULED, MEETING_STATUS.PENDING_RESCHEDULE],
  completed: [MEETING_STATUS.COMPLETED],
  replaced: [MEETING_STATUS.PREEMPTED],
  cancelled: [MEETING_STATUS.CANCELLED],
} as const satisfies Record<string, readonly number[]>;

export type BookingTab = keyof typeof BOOKING_TABS;

export function isBookingTab(value: unknown): value is BookingTab {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BOOKING_TABS, value);
}

type ListOptions = {
  tab?: BookingTab;
  // "YYYY-MM-DD": only meetings on that day.
  date?: string;
};

function listWhere(employeeId: number, { tab, date }: ListOptions) {
  return and(
    involvesEmployee(employeeId),
    tab ? inArray(meeting.meetingStatusId, [...BOOKING_TABS[tab]]) : undefined,
    date ? eq(meeting.meeting_date, date) : undefined
  );
}

// How many meetings each tab holds (for the tab labels and the page count).
export async function countMyBookingsByTab(
  employeeId: number,
  date?: string
): Promise<Record<BookingTab, number>> {
  const rows = await db
    .select({ statusId: meeting.meetingStatusId, count: sql<number>`count(*)::int` })
    .from(meeting)
    .where(listWhere(employeeId, { date }))
    .groupBy(meeting.meetingStatusId);

  const counts = { scheduled: 0, completed: 0, replaced: 0, cancelled: 0 };

  for (const tab of Object.keys(BOOKING_TABS) as BookingTab[]) {
    counts[tab] = rows
      .filter((r) => (BOOKING_TABS[tab] as readonly number[]).includes(r.statusId))
      .reduce((sum, r) => sum + r.count, 0);
  }

  return counts;
}

// One page of a tab, newest first. meeting_id makes the order total, so a
// meeting never appears on two pages or on none.
export async function listMyBookingsPage(
  employeeId: number,
  options: ListOptions & { page: number; pageSize: number }
) {
  return selectMyBookings()
    .where(listWhere(employeeId, options))
    .orderBy(desc(meeting.meeting_date), desc(meeting.start_time), desc(meeting.meeting_id))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
}

// Every meeting of the employee (no paging), newest first.
export async function listMyBookings(employeeId: number) {
  return selectMyBookings()
    .where(involvesEmployee(employeeId))
    .orderBy(desc(meeting.meeting_date), desc(meeting.start_time));
}

function selectMyBookings() {
  return db
    .select({
      meetingId: meeting.meeting_id,
      title: meeting.title,
      meetingDate: meeting.meeting_date,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      participantCount: meeting.participantCount,
      roomName: room.room_name,
      meetingType: meetingTypes.meetingTypeName,
      meetingStatus: meetingStatuses.meetingStatusName,
      meetingStatusId: meeting.meetingStatusId,
      organizerEmployeeId: meeting.organizerEmployeeId,
      isOnline: meeting.is_online,
      onlineJoinUrl: meeting.online_join_url,
      onlineRequested: meeting.online_requested,
      onlineStatus: meeting.online_status,
      recurringMeetingId: meeting.recurringMeetingId,
    })
    .from(meeting)
    .leftJoin(room, eq(room.room_id, meeting.room_id))
    .leftJoin(
      meetingTypes,
      eq(meetingTypes.meetingTypeId, meeting.meetingTypeId)
    )
    .leftJoin(
      meetingStatuses,
      eq(meetingStatuses.meetingStatusId, meeting.meetingStatusId)
    )
    .$dynamic();
}
