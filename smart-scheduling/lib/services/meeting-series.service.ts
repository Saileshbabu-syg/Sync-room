import { eq } from "drizzle-orm";

import {
  employee,
  meeting,
  recurrence_frequency_master,
  recurring_meetings,
  room,
} from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";

import { computeOccurrenceDates } from "@/lib/recurrence";

// What a confirmation e-mail says about a recurring series. It is built from the
// `meeting` rows that were actually saved (one per occurrence), never from the
// request, so the e-mail cannot disagree with what the app shows.

export type SeriesOccurrence = {
  date: string;
  startTime: string;
  endTime: string;
};

export type MeetingEmailSeries = {
  frequency: string;
  startDate: string;
  endDate: string;
  // Confirmed occurrences, in date order.
  occurrences: SeriesOccurrence[];
  // Dates of the recurrence pattern that were left out when booking.
  skippedDates: string[];
  // Occurrences that were booked and cancelled afterwards.
  cancelledDates: string[];
};

type SeriesRow = {
  meeting_date: string;
  start_time: string;
  end_time: string;
  meetingStatusId: number;
};

const FREQUENCY_LABELS: Record<string, string> = {
  DAILY: "Daily (Monday to Friday)",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
};

export function frequencyLabel(name: string) {
  const key = name.toUpperCase();

  return (
    FREQUENCY_LABELS[key] ??
    key.charAt(0) + key.slice(1).toLowerCase()
  );
}

// Dates the pattern produces between the first and last booked date that have
// no meeting row at all: those are the ones skipped at booking time. The dates
// come from the same computeOccurrenceDates() the booking used. If the saved
// rows do not sit on that grid (it cannot be reconstructed reliably, e.g. a
// monthly series whose first date was skipped) nothing is claimed as skipped.
function findSkippedDates(
  bookedDates: string[],
  frequencyId: number
): string[] {
  const first = bookedDates[0];
  const last = bookedDates[bookedDates.length - 1];

  // Every step advances at least one day, so this many steps always reach `last`.
  const span =
    Math.round(
      (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
        86_400_000
    ) + 1;

  const grid = computeOccurrenceDates(first, frequencyId, span).filter(
    (d) => d <= last
  );

  const booked = new Set(bookedDates);
  const onGrid = new Set(grid);

  if (bookedDates.some((d) => !onGrid.has(d))) return [];

  return grid.filter((d) => !booked.has(d));
}

// Pure: rows of one series -> the series section of the e-mail. Returns null
// when no occurrence is confirmed any more.
export function buildSeriesEmail(
  frequencyId: number,
  frequencyName: string,
  rows: SeriesRow[]
): MeetingEmailSeries | null {
  const sorted = [...rows].sort(
    (a, b) =>
      a.meeting_date.localeCompare(b.meeting_date) ||
      a.start_time.localeCompare(b.start_time)
  );

  const confirmed = sorted.filter(
    (r) => r.meetingStatusId !== MEETING_STATUS.CANCELLED
  );

  if (confirmed.length === 0) return null;

  const cancelledDates = sorted
    .filter((r) => r.meetingStatusId === MEETING_STATUS.CANCELLED)
    .map((r) => r.meeting_date);

  const allDates = [...new Set(sorted.map((r) => r.meeting_date))];

  return {
    frequency: frequencyLabel(frequencyName),
    startDate: confirmed[0].meeting_date,
    endDate: confirmed[confirmed.length - 1].meeting_date,
    occurrences: confirmed.map((r) => ({
      date: r.meeting_date,
      startTime: String(r.start_time),
      endTime: String(r.end_time),
    })),
    skippedDates: findSkippedDates(allDates, frequencyId),
    cancelledDates,
  };
}

export type SeriesEmailContext = {
  roomName: string;
  organizerName: string;
  series: MeetingEmailSeries;
};

// Loads every saved occurrence of a series. Null when the series has no
// confirmed occurrence left (nothing worth announcing).
export async function loadSeriesEmailContext(
  executor: DbExecutor,
  recurringMeetingId: number
): Promise<SeriesEmailContext | null> {
  const [series] = await executor
    .select({
      frequencyId: recurring_meetings.frequency_id,
      frequencyName: recurrence_frequency_master.frequency_name,
    })
    .from(recurring_meetings)
    .innerJoin(
      recurrence_frequency_master,
      eq(
        recurrence_frequency_master.frequency_id,
        recurring_meetings.frequency_id
      )
    )
    .where(eq(recurring_meetings.recurring_meeting_id, recurringMeetingId));

  if (!series) return null;

  const rows = await executor
    .select({
      meeting_date: meeting.meeting_date,
      start_time: meeting.start_time,
      end_time: meeting.end_time,
      meetingStatusId: meeting.meetingStatusId,
      roomName: room.room_name,
      organizerName: employee.employee_name,
    })
    .from(meeting)
    .innerJoin(room, eq(room.room_id, meeting.room_id))
    .innerJoin(
      employee,
      eq(employee.employee_id, meeting.organizerEmployeeId)
    )
    .where(eq(meeting.recurringMeetingId, recurringMeetingId));

  if (rows.length === 0) return null;

  const built = buildSeriesEmail(
    series.frequencyId,
    series.frequencyName,
    rows
  );

  if (!built) return null;

  return {
    roomName: rows[0].roomName,
    organizerName: rows[0].organizerName,
    series: built,
  };
}
