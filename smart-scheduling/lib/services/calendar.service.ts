import { createEvent, createEvents } from "ics";

import { appWallClockToUtc } from "@/lib/time";

// Meeting dates and times are wall-clock values in APP_TIMEZONE. They are
// converted to UTC explicitly so the invite does not depend on the timezone of
// the server that generates it.
const utcTimes = (date: string, startTime: string, endTime: string) => ({
  start: appWallClockToUtc(date, startTime),
  end: appWallClockToUtc(date, endTime),
  startInputType: "utc" as const,
  startOutputType: "utc" as const,
  endInputType: "utc" as const,
  endOutputType: "utc" as const,
});

export async function generateCalendarInvite(
  title: string,
  meetingDate: string,
  startTime: string,
  endTime: string
) {
  const { error, value } = createEvent({
    title,

    ...utcTimes(meetingDate, startTime, endTime),

    status: "CONFIRMED",

    busyStatus: "BUSY",
  });

  if (error || !value) {
    throw new Error(
      "Failed to generate calendar invite"
    );
  }

  return value;
}

// One VEVENT per saved occurrence (not an RRULE), so the invite always matches
// the bookings exactly, including skipped and cancelled dates.
export async function generateSeriesCalendarInvite(
  title: string,
  occurrences: { date: string; startTime: string; endTime: string }[],
  location?: string
) {
  const { error, value } = createEvents(
    occurrences.map((o) => ({
      title,
      ...utcTimes(o.date, o.startTime, o.endTime),
      ...(location ? { location } : {}),
      status: "CONFIRMED" as const,
      busyStatus: "BUSY" as const,
    }))
  );

  if (error || !value) {
    throw new Error("Failed to generate calendar invite");
  }

  return value;
}
