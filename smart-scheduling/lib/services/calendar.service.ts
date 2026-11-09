import { createEvent, createEvents, type EventAttributes } from "ics";

import { appWallClockToUtc, slotEndDate } from "@/lib/time";

// Meeting dates and times are wall-clock values in APP_TIMEZONE. They are
// converted to UTC explicitly so the invite does not depend on the timezone of
// the server that generates it (DTSTART/DTEND are written as UTC, "...Z"). An
// overnight meeting ends on the day after its date.
const utcTimes = (date: string, startTime: string, endTime: string) => ({
  start: appWallClockToUtc(date, startTime),
  end: appWallClockToUtc(slotEndDate(date, startTime, endTime), endTime),
  startInputType: "utc" as const,
  startOutputType: "utc" as const,
  endInputType: "utc" as const,
  endOutputType: "utc" as const,
});

// Which calendar entry an invite is about, and its current version. Every
// invite for the same meeting carries the same UID, so calendar clients
// (Outlook, Google, Apple...) update or remove the entry they already have
// instead of adding another one.
export type CalendarIdentity = {
  meetingId: number;
  // meeting.ics_sequence: raised whenever the entry moves or is renamed.
  sequence: number;
  // The room; shown as the entry's location.
  location?: string;
};

export type CalendarOrganizer = { name?: string; email: string };

// REQUEST: create or update the entry. CANCEL: remove it.
export type CalendarMethod = "REQUEST" | "CANCEL";

const FALLBACK_UID_HOST = "meetsched.local";

// "meeting-42@rooms.example.com": stable for the meeting's lifetime, across
// e-mails and restarts. The host is the configured public origin's (AUTH_URL),
// so two deployments never share UIDs.
export function calendarUid(
  meetingId: number,
  env: Record<string, string | undefined> = process.env
) {
  let host = FALLBACK_UID_HOST;

  try {
    const configured = env.AUTH_URL ?? env.NEXTAUTH_URL;

    if (configured) host = new URL(configured).hostname || host;
  } catch {
    // Unparseable origin: keep the fallback.
  }

  return `meeting-${meetingId}@${host}`;
}

const TEAMS_LOCATION = "Microsoft Teams Meeting";

function describeEntry(identity: CalendarIdentity | undefined, joinUrl?: string) {
  const location = [identity?.location, joinUrl ? TEAMS_LOCATION : undefined]
    .filter(Boolean)
    .join(" / ");

  return {
    ...(location ? { location } : {}),
    // The Teams link as a property (clients that show it) and in the
    // description (clients that do not).
    ...(joinUrl
      ? { url: joinUrl, description: `Join Microsoft Teams Meeting: ${joinUrl}` }
      : {}),
  };
}

// The UID / SEQUENCE / METHOD part of an event. A cancellation goes out one
// version above the current one, which is above every invite already sent.
function identityFields(
  identity: CalendarIdentity | undefined,
  method: CalendarMethod
): Partial<EventAttributes> {
  if (!identity) return {};

  return {
    uid: calendarUid(identity.meetingId),
    sequence: method === "CANCEL" ? identity.sequence + 1 : identity.sequence,
  };
}

export async function generateCalendarInvite(
  title: string,
  meetingDate: string,
  startTime: string,
  endTime: string,
  // Online Teams Meeting: shown in the calendar entry. Absent for a normal
  // meeting.
  joinUrl?: string,
  // Without an identity the invite is a one-off (random UID) as it always was;
  // every application path passes one.
  options: {
    identity?: CalendarIdentity;
    method?: CalendarMethod;
    organizer?: CalendarOrganizer;
  } = {}
) {
  const method = options.method ?? "REQUEST";

  const { error, value } = createEvent({
    title,

    ...utcTimes(meetingDate, startTime, endTime),

    ...describeEntry(options.identity, joinUrl),

    ...identityFields(options.identity, method),

    ...(options.identity ? { method } : {}),

    ...(options.organizer ? { organizer: options.organizer } : {}),

    status: method === "CANCEL" ? "CANCELLED" : "CONFIRMED",

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
// the bookings exactly, including skipped and cancelled dates. Each occurrence
// is its own meeting, with its own UID and version, so a later update or
// cancellation of one occurrence replaces exactly that entry. Several entries
// in one file are a PUBLISH (iTIP allows one UID per REQUEST).
export async function generateSeriesCalendarInvite(
  title: string,
  occurrences: {
    date: string;
    startTime: string;
    endTime: string;
    joinUrl?: string;
    meetingId?: number;
    sequence?: number;
  }[],
  location?: string,
  organizer?: CalendarOrganizer
) {
  const { error, value } = createEvents(
    occurrences.map((o) => {
      const identity =
        o.meetingId !== undefined
          ? { meetingId: o.meetingId, sequence: o.sequence ?? 0, location }
          : undefined;

      return {
        title,
        ...utcTimes(o.date, o.startTime, o.endTime),
        ...(identity
          ? describeEntry(identity, o.joinUrl)
          : {
              ...(location ? { location } : {}),
              ...(o.joinUrl ? { url: o.joinUrl } : {}),
            }),
        ...identityFields(identity, "REQUEST"),
        ...(organizer ? { organizer } : {}),
        status: "CONFIRMED" as const,
        busyStatus: "BUSY" as const,
      };
    }),
    { method: "PUBLISH" }
  );

  if (error || !value) {
    throw new Error("Failed to generate calendar invite");
  }

  return value;
}
