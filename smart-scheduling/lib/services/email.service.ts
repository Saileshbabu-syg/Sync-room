import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import {
  generateCalendarInvite,
  generateSeriesCalendarInvite,
} from "./calendar.service";
import type { MeetingEmailSeries } from "./meeting-series.service";
import { APP_TIMEZONE } from "@/lib/constants";
import { formatTime, formatTimeRange } from "@/lib/format";
import { escapeHtml, sanitizeHeaderValue } from "@/lib/html";

// The one place booking e-mail leaves the application. Every booking-related
// message (confirmation, series confirmation, update, reminder) goes through
// sendMeetingEmail(), so there is a single sender and a single transport.
//
// Configuration (environment only, nothing is hard-coded):
//   EMAIL_FROM     the official sender, e.g. "Meeting Rooms <rooms@company.com>"
//   SMTP_HOST      the organisation's approved SMTP relay
//   SMTP_PORT      default 587
//   SMTP_SECURE    "true"  = implicit TLS (SMTPS, normally port 465)
//                  "false" = plaintext connection upgraded with STARTTLS
//                  unset   = implicit TLS on port 465, STARTTLS otherwise
//   SMTP_USER / SMTP_PASSWORD   only when the relay requires authentication
//   SMTP_ALLOW_INSECURE  development only: "true" lets a local relay/sink
//                  without TLS be used. Never needed for a real provider.
//
// TLS is mandatory: with STARTTLS, nodemailer's requireTLS makes the send fail
// when the server does not offer it, instead of silently continuing in
// plaintext (so credentials and mail are never sent unencrypted), and
// certificates are always verified.

let transporter: Transporter | null = null;

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Pure so the validation can be tested without opening a connection.
export function buildSmtpOptions(
  env: NodeJS.ProcessEnv = process.env
): SMTPTransport.Options {
  const host = env.SMTP_HOST?.trim();

  if (!host) {
    throw new EmailConfigError(
      "Email is not configured: set SMTP_HOST (and EMAIL_FROM)."
    );
  }

  const portText = (env.SMTP_PORT ?? "587").trim();
  const port = Number(portText);

  if (!/^[0-9]+$/.test(portText) || port < 1 || port > 65535) {
    throw new EmailConfigError("SMTP_PORT must be a port number (1-65535).");
  }

  const secureText = env.SMTP_SECURE?.trim().toLowerCase();

  if (secureText && secureText !== "true" && secureText !== "false") {
    throw new EmailConfigError('SMTP_SECURE must be "true" or "false".');
  }

  // Implicit TLS and STARTTLS are different protocols on different ports; when
  // SMTP_SECURE is not set, port 465 means implicit TLS and anything else
  // means STARTTLS.
  const secure = secureText ? secureText === "true" : port === 465;

  const allowInsecure = env.SMTP_ALLOW_INSECURE?.trim().toLowerCase() === "true";

  if (
    allowInsecure &&
    env.NODE_ENV === "production" &&
    !LOOPBACK_HOSTS.has(host.toLowerCase())
  ) {
    throw new EmailConfigError(
      "SMTP_ALLOW_INSECURE is for local development only and cannot be used with a non-local SMTP_HOST in production."
    );
  }

  const user = env.SMTP_USER?.trim();

  if (user && !env.SMTP_PASSWORD) {
    throw new EmailConfigError("SMTP_USER is set but SMTP_PASSWORD is not.");
  }

  if (allowInsecure) {
    console.warn(
      "SMTP_ALLOW_INSECURE=true: mail may be sent without TLS. Development only."
    );
  }

  return {
    host,
    port,
    secure,
    // STARTTLS is mandatory unless the developer opted out explicitly.
    ...(!secure && !allowInsecure ? { requireTLS: true } : {}),
    tls: { minVersion: "TLSv1.2" },
    // Bounded waits so a hung relay cannot stall the reminder job.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...(user ? { auth: { user, pass: env.SMTP_PASSWORD } } : {}),
  };
}

// Existing setup, kept until the company mail relay is integrated: with no
// SMTP_HOST but EMAIL_USER / EMAIL_PASSWORD set, mail goes out through Gmail
// from EMAIL_USER, exactly as before. Setting SMTP_HOST (and EMAIL_FROM)
// switches to the SMTP relay above; nothing else needs to change.
export function legacyGmailAccount(env: NodeJS.ProcessEnv = process.env) {
  const user = env.EMAIL_USER?.trim();

  return !env.SMTP_HOST?.trim() && user && env.EMAIL_PASSWORD
    ? { user, pass: env.EMAIL_PASSWORD }
    : null;
}

function createDefaultTransport(): Transporter {
  const gmail = legacyGmailAccount();

  if (gmail) {
    return nodemailer.createTransport({ service: "gmail", auth: gmail });
  }

  return nodemailer.createTransport(buildSmtpOptions());
}

function getTransporter(): Transporter {
  transporter ??= createDefaultTransport();
  return transporter;
}

// Test hook: swap the transport (e.g. nodemailer's jsonTransport). Pass null to
// go back to the default.
export function setMailTransport(next: Transporter | null) {
  transporter = next;
}

// Pure so it can be validated without touching process.env.
function parseSender(value: string | undefined): string {
  const from = value?.trim();

  if (!from) {
    throw new EmailConfigError("Email is not configured: set EMAIL_FROM.");
  }

  // One plain mailbox ("a@b.c" or "Name <a@b.c>"): no line breaks (header
  // injection) and no address list.
  if (
    /[\r\n]/.test(from) ||
    !/^(?:[^<>@,;]*<[^<>@\s,;]+@[^<>@\s,;]+>|[^<>@\s,;]+@[^<>@\s,;]+)$/.test(from)
  ) {
    throw new EmailConfigError(
      'EMAIL_FROM must be a single address such as "Meeting Rooms <rooms@company.com>".'
    );
  }

  return from;
}

// The configured sender, used for every message. Throws (so the notification
// stays PENDING and is retried) instead of sending from a wrong address.
export function getMailSender(): string {
  return parseSender(process.env.EMAIL_FROM ?? legacyGmailAccount()?.user);
}

// Everything wrong with the e-mail configuration, as readable messages, for a
// startup check. Never includes a value, only names. Empty when sending can
// work.
export function emailConfigProblems(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const problems: string[] = [];

  // The existing Gmail setup is complete on its own.
  if (legacyGmailAccount(env) && !env.EMAIL_FROM) return problems;

  for (const check of [
    () => buildSmtpOptions(env),
    () => parseSender(env.EMAIL_FROM),
  ]) {
    try {
      check();
    } catch (error) {
      if (!(error instanceof EmailConfigError)) throw error;
      problems.push(error.message);
    }
  }

  if ((env.EMAIL_USER || env.EMAIL_PASSWORD) && !env.SMTP_USER) {
    problems.push(
      "EMAIL_USER / EMAIL_PASSWORD are not used: rename them to SMTP_USER / SMTP_PASSWORD."
    );
  }

  return problems;
}

export type MeetingEmailKind =
  | "scheduled"
  | "updated"
  | "reminder"
  | "cancelled"
  | "bumped"
  | "preempted";

const HEADINGS: Record<MeetingEmailKind, string> = {
  scheduled: "Meeting Scheduled",
  updated: "Meeting Updated",
  reminder: "Meeting Reminder",
  cancelled: "Meeting Cancelled",
  bumped: "Meeting Room Needed - Action Required",
  preempted: "Meeting Preempted",
};

const SERIES_HEADINGS: Record<MeetingEmailKind, string> = {
  scheduled: "Recurring Meeting Scheduled",
  updated: "Recurring Meeting Updated",
  reminder: "Recurring Meeting Reminder",
  cancelled: "Recurring Meeting Cancelled",
  bumped: "Meeting Room Needed - Action Required",
  preempted: "Meeting Preempted",
};

// Set on a "preempted" e-mail: a higher-priority group's booking took this
// meeting's room. The meeting is cancelled for good; the organizer rebooks.
export type MeetingPreemptionInfo = {
  roomName: string;
  // e.g. "a Leadership booking (priority 1)"
  claimedBy: string;
  rebookUrl?: string;
};

// Set on a "bumped" e-mail: a higher-priority booking took this meeting's room.
export type MeetingBumpInfo = {
  // e.g. "Interview organized by Priya HR"
  claimedBy: string;
  // The room the meeting had (now held by the higher-priority meeting).
  roomName: string;
  // While the meeting is pending: the last moment its organizer can change the
  // room or time ("YYYY-MM-DD 02:30 PM"). Undefined once it has been cancelled.
  deadline?: string;
  // Link to change the room or time, when the app URL is configured.
  changeUrl?: string;
  // Link to start a new booking, when the app URL is configured.
  rebookUrl?: string;
};

// Extra details used for a recurring series. Without `series` the message is
// the one-date format.
export type MeetingEmailExtras = {
  roomName?: string;
  organizerName?: string;
  series?: MeetingEmailSeries;
  bump?: MeetingBumpInfo;
  preemption?: MeetingPreemptionInfo;
  // Online Teams Meeting: the joining link of THIS meeting. Absent for a normal
  // meeting, whose e-mail is then exactly what it always was.
  online?: { joinUrl: string };
  // The meeting's calendar identity (stable UID + current version). With it,
  // invites update the recipients' existing entry and a cancellation removes
  // it. Every application path passes it.
  calendar?: { meetingId: number; sequence: number };
};

type MeetingEmailFields = {
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  kind?: MeetingEmailKind;
} & MeetingEmailExtras;

// The meeting no longer takes place for these messages: a cancellation, a
// replacement, or a bump that was not resolved in time.
function isCalendarRemoval(kind: MeetingEmailKind, bump?: MeetingBumpInfo) {
  return (
    kind === "cancelled" ||
    kind === "preempted" ||
    (kind === "bumped" && !bump?.deadline)
  );
}

// The sender, as the calendar entry's organizer: iTIP updates and
// cancellations are honoured when they come from the organizer.
function calendarOrganizer() {
  const sender = getMailSender();
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(sender);

  return match
    ? { ...(match[1] ? { name: match[1] } : {}), email: match[2] }
    : { email: sender.trim() };
}

const icsAttachment = (content: string, method: "REQUEST" | "CANCEL" | "PUBLISH") => ({
  filename: method === "CANCEL" ? "meeting-cancel.ics" : "meeting-invite.ics",
  content,
  contentType: `text/calendar; method=${method}; charset=UTF-8`,
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "2026-12-01" -> "2026-12-01 (Tue)". Dates are wall-clock dates in
// APP_TIMEZONE (as stored and as shown in the app); the weekday is computed
// from the date alone, so no timezone conversion can shift it.
function withWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return Number.isNaN(day) ? date : `${date} (${WEEKDAYS[day]})`;
}

// The zone's offset from UTC, in minutes, at the instant `utcMs`.
function zoneOffsetMinutes(zone: string, utcMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute")
  );

  return Math.round((asUtc - utcMs) / 60_000);
}

// "Asia/Kolkata (UTC+05:30)": the zone a stored wall-clock date + time is in,
// with its UTC offset AT THAT MOMENT (zones with daylight saving have two).
// Display only; how times are stored and converted is unchanged.
export function timeZoneLabel(
  date: string,
  time: string,
  zone: string = APP_TIMEZONE
) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);

  if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) return zone;

  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - zoneOffsetMinutes(zone, wall) * 60_000;
  utc = wall - zoneOffsetMinutes(zone, utc) * 60_000;

  const offset = zoneOffsetMinutes(zone, utc);
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");

  return `${zone} (UTC${offset < 0 ? "-" : "+"}${hh}:${mm})`;
}

// One recipient: To. Several: Bcc only, so no attendee sees the others'
// addresses. Still ONE message, so delivery stays all-or-nothing and a retry
// never re-sends to part of the list.
export function addressing(to: string | string[]) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);

  return list.length > 1 ? { bcc: list } : { to: list[0] };
}

const TEAMS_LABEL = "Microsoft Teams";

// A clickable "Join Meeting" button. The URL is untrusted text here, so it is
// escaped once at the point of interpolation.
function joinButton(url: string) {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 22px;border-radius:6px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600">Join Meeting</a>`;
}

function renderSingle({
  title,
  meetingDate,
  startTime,
  endTime,
  kind = "scheduled",
  bump,
  preemption,
  online,
  calendar,
}: MeetingEmailFields) {
  // A bumped meeting is either waiting for its organizer to change it (it has
  // a deadline) or already cancelled.
  const cancelledByBump = kind === "bumped" && !bump?.deadline;
  const heading = cancelledByBump ? HEADINGS.cancelled : HEADINGS[kind];
  // Neither a cancellation nor a pending meeting carries an invite: a new .ics
  // would add a stray event for a slot the meeting no longer holds.
  const hasInvite =
    kind !== "cancelled" && kind !== "bumped" && kind !== "preempted";
  // A meeting that no longer takes place carries a calendar CANCELLATION for
  // the entry the recipients already have (only possible with its identity).
  const calendarNote = hasInvite
    ? "Calendar invite attached."
    : calendar && isCalendarRemoval(kind, bump)
      ? "Calendar cancellation attached: it removes this meeting from your calendar."
      : null;

  const bumpLines: string[] = preemption
    ? [
        `The meeting room (${preemption.roomName}) was needed for ${preemption.claimedBy}, which takes priority over this booking.`,
        `This booking has been replaced and no longer holds the room. Please book another available slot${preemption.rebookUrl ? `: ${preemption.rebookUrl}` : "."}`,
      ]
    : bump
    ? bump.deadline
      ? [
          `The meeting room (${bump.roomName}) is required for a high-priority meeting: ${bump.claimedBy}.`,
          `The organizer can change the room or time${bump.changeUrl ? `: ${bump.changeUrl}` : "."} If it is not changed by ${bump.deadline}, the meeting will be cancelled automatically.`,
        ]
      : [
          `The meeting room (${bump.roomName}) was required for a high-priority meeting: ${bump.claimedBy}.`,
          `The meeting has been cancelled because its room or time was not changed in time. Please book another available slot${bump.rebookUrl ? `: ${bump.rebookUrl}` : "."}`,
        ]
    : [];

  const zone = timeZoneLabel(meetingDate, startTime);

  // No joining link for a meeting that no longer happens.
  const joinUrl =
    online && kind !== "cancelled" && kind !== "bumped" && kind !== "preempted"
      ? online.joinUrl
      : undefined;

  const onlineHtml = joinUrl
    ? `

      <p><strong>Meeting type:</strong> ${TEAMS_LABEL}</p>

      <p>${joinButton(joinUrl)}</p>

      <p>Join link: <a href="${escapeHtml(joinUrl)}">${escapeHtml(joinUrl)}</a></p>`
    : "";

  const html = `
      <h2>${escapeHtml(heading)}</h2>
${bumpLines.map((l) => `
      <p>${escapeHtml(l)}</p>`).join("")}

      <p><strong>Title:</strong> ${escapeHtml(title)}</p>

      <p><strong>Date:</strong> ${escapeHtml(meetingDate)}</p>

      <p><strong>Start Time:</strong> ${escapeHtml(formatTime(startTime))}</p>

      <p><strong>End Time:</strong> ${escapeHtml(formatTime(endTime))}</p>

      <p><strong>Time zone:</strong> ${escapeHtml(zone)}</p>${onlineHtml}
${
  calendarNote
    ? `
      <p>
        ${escapeHtml(calendarNote)}
      </p>`
    : ""
}
    `;

  const text = [
    heading,
    "",
    ...(bumpLines.length > 0 ? [...bumpLines, ""] : []),
    `Title: ${title}`,
    `Date: ${meetingDate}`,
    `Start Time: ${formatTime(startTime)}`,
    `End Time: ${formatTime(endTime)}`,
    `Time zone: ${zone}`,
    ...(joinUrl
      ? ["", `Meeting type: ${TEAMS_LABEL}`, `Join Meeting: ${joinUrl}`]
      : []),
    ...(calendarNote ? ["", calendarNote] : []),
  ].join("\n");

  return {
    subject: `${heading} - ${sanitizeHeaderValue(title)}`,
    html,
    text,
  };
}

function renderSeries(
  {
    title,
    roomName,
    organizerName,
    meetingDate,
    startTime,
    endTime,
    kind = "scheduled",
    online,
  }: MeetingEmailFields,
  series: MeetingEmailSeries
) {
  // Each occurrence has its own Teams meeting and link.
  const isOnlineSeries =
    Boolean(online) || series.occurrences.some((o) => o.joinUrl);
  const heading = SERIES_HEADINGS[kind];
  const count = series.occurrences.length;
  const zones = series.occurrences.map((o) =>
    timeZoneLabel(o.date, o.startTime)
  );
  // A reminder carries only the invite for its own meeting, so the other
  // occurrences are not duplicated in the recipient's calendar.
  const inviteNote =
    kind === "reminder"
      ? "Calendar invite attached (this meeting)."
      : "Calendar invite attached (one event per occurrence).";

  const details: [string, string][] = [
    ["Title", title],
    ...(kind === "reminder"
      ? ([
          [
            "This meeting",
            `${withWeekday(meetingDate)}, ${formatTimeRange(startTime, endTime)}`,
          ],
        ] as [string, string][])
      : []),
    ...(roomName ? ([["Room", roomName]] as [string, string][]) : []),
    ...(isOnlineSeries
      ? ([["Meeting type", TEAMS_LABEL]] as [string, string][])
      : []),
    ...(organizerName
      ? ([["Organizer", organizerName]] as [string, string][])
      : []),
    ["Repeats", series.frequency],
    ["Series start", withWeekday(series.startDate)],
    ["Series end", withWeekday(series.endDate)],
    ["Time zone", zones[0] ?? timeZoneLabel(meetingDate, startTime)],
    ["Confirmed occurrences", String(count)],
  ];

  // Where the series crosses a daylight-saving change, every line carries its
  // own offset; otherwise the one "Time zone" line says it all.
  const perLineZone = new Set(zones).size > 1;
  const lines = series.occurrences.map(
    (o, i) =>
      `${withWeekday(o.date)}, ${formatTimeRange(o.startTime, o.endTime)}${
        perLineZone ? ` ${zones[i]}` : ""
      }`
  );

  const html = `
      <h2>${escapeHtml(heading)}</h2>

      ${details
        .map(
          ([label, value]) =>
            `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`
        )
        .join("\n      ")}

      <p><strong>Dates and times (${escapeHtml(APP_TIMEZONE)}):</strong></p>

      <ol>
        ${lines
          .map((l, i) => {
            const url = series.occurrences[i].joinUrl;

            return `<li>${escapeHtml(l)}${
              url ? ` - <a href="${escapeHtml(url)}">Join Meeting</a>` : ""
            }</li>`;
          })
          .join("\n        ")}
      </ol>${
        kind === "reminder" && online
          ? `

      <p>${joinButton(online.joinUrl)}</p>`
          : ""
      }
      ${
        series.skippedDates.length > 0
          ? `
      <p><strong>Skipped dates (not booked):</strong></p>

      <ul>
        ${series.skippedDates
          .map((d) => `<li>${escapeHtml(withWeekday(d))}</li>`)
          .join("\n        ")}
      </ul>`
          : ""
      }${
        series.cancelledDates.length > 0
          ? `
      <p><strong>Cancelled occurrences:</strong></p>

      <ul>
        ${series.cancelledDates
          .map((d) => `<li>${escapeHtml(withWeekday(d))}</li>`)
          .join("\n        ")}
      </ul>`
          : ""
      }
      <p>
        ${inviteNote}
      </p>
    `;

  const text = [
    heading,
    "",
    ...details.map(([label, value]) => `${label}: ${value}`),
    "",
    `Dates and times (${APP_TIMEZONE}):`,
    ...lines.map((l, i) => {
      const url = series.occurrences[i].joinUrl;

      return `${i + 1}. ${l}${url ? ` - Join Meeting: ${url}` : ""}`;
    }),
    ...(kind === "reminder" && online
      ? ["", `Join Meeting: ${online.joinUrl}`]
      : []),
    ...(series.skippedDates.length > 0
      ? [
          "",
          "Skipped dates (not booked):",
          ...series.skippedDates.map((d) => `- ${withWeekday(d)}`),
        ]
      : []),
    ...(series.cancelledDates.length > 0
      ? [
          "",
          "Cancelled occurrences:",
          ...series.cancelledDates.map((d) => `- ${withWeekday(d)}`),
        ]
      : []),
    "",
    inviteNote,
  ].join("\n");

  return {
    subject: `${heading} - ${sanitizeHeaderValue(title)}`,
    html,
    text,
  };
}

// Every dynamic value is untrusted (titles are typed by any employee), so it
// is HTML-escaped exactly once, here, at the point of interpolation. Header
// values are stripped of line breaks.
export function renderMeetingEmail(fields: MeetingEmailFields) {
  return fields.series
    ? renderSeries(fields, fields.series)
    : renderSingle(fields);
}

export async function sendMeetingEmail(
  to: string | string[],
  title: string,
  meetingDate: string,
  startTime: string,
  endTime: string,
  kind: MeetingEmailKind = "scheduled",
  extras: MeetingEmailExtras = {}
) {
  const identity = extras.calendar
    ? { ...extras.calendar, location: extras.roomName }
    : undefined;
  const organizer = identity ? calendarOrganizer() : undefined;

  // What goes in the calendar part:
  //  - a meeting that no longer takes place: a CANCEL for its entry (only
  //    with its identity; without one there is nothing to cancel);
  //  - a bumped meeting still waiting for its organizer: nothing (it holds no
  //    slot, and its attendees hear the outcome later);
  //  - a series confirmation: every occurrence, one entry each (PUBLISH);
  //  - anything else: a REQUEST that creates or updates this meeting's entry.
  let calendarPart: { content: string; method: "REQUEST" | "CANCEL" | "PUBLISH" } | null =
    null;

  if (isCalendarRemoval(kind, extras.bump)) {
    if (identity) {
      calendarPart = {
        method: "CANCEL",
        content: await generateCalendarInvite(
          title,
          meetingDate,
          startTime,
          endTime,
          undefined,
          { identity, method: "CANCEL", organizer }
        ),
      };
    }
  } else if (kind === "bumped") {
    calendarPart = null;
  } else if (extras.series && kind !== "reminder") {
    calendarPart = {
      method: "PUBLISH",
      content: await generateSeriesCalendarInvite(
        title,
        extras.series.occurrences,
        extras.roomName,
        organizer
      ),
    };
  } else {
    calendarPart = {
      method: "REQUEST",
      content: await generateCalendarInvite(
        title,
        meetingDate,
        startTime,
        endTime,
        extras.online?.joinUrl,
        { identity, method: "REQUEST", organizer }
      ),
    };
  }

  const { subject, html, text } = renderMeetingEmail({
    title,
    meetingDate,
    startTime,
    endTime,
    kind,
    ...extras,
  });

  const from = getMailSender();

  return getTransporter().sendMail({
    from,

    ...addressing(to),

    subject,

    html,

    text,

    attachments: calendarPart
      ? [icsAttachment(calendarPart.content, calendarPart.method)]
      : [],
  });
}

export type InvitationFields = {
  title: string;
  organizerName: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  acceptUrl: string;
  declineUrl: string;
  // Invited as an optional participant: they may attend if available, and their
  // answer does not affect the meeting.
  optional?: boolean;
  // Set for a recurring series: the answer covers every occurrence.
  seriesNote?: string;
  // Online Teams Meeting: the link of the meeting this invitation is for and,
  // for a series, the link of every occurrence (each has its own).
  joinUrl?: string;
  occurrenceLinks?: { date: string; joinUrl: string }[];
  // The meeting's calendar identity (see MeetingEmailExtras.calendar).
  calendar?: { meetingId: number; sequence: number };
};

// The personal invitation each participant receives. Every dynamic value is
// untrusted, so it is escaped once here; the two links are built by the
// application from signed tokens (lib/invitation-token).
const OPTIONAL_NOTE =
  "Your attendance is optional. Attend if you are available; your answer does not affect the meeting.";

export function renderInvitationEmail(fields: InvitationFields) {
  const heading = "Meeting Invitation";
  const details: [string, string][] = [
    ["Title", fields.title],
    ["Organizer", fields.organizerName],
    ["Room", fields.roomName],
    ["Date", withWeekday(fields.meetingDate)],
    ["Start Time", formatTime(fields.startTime)],
    ["End Time", formatTime(fields.endTime)],
    ["Time zone", timeZoneLabel(fields.meetingDate, fields.startTime)],
    ...(fields.joinUrl
      ? ([["Meeting type", TEAMS_LABEL]] as [string, string][])
      : []),
  ];

  const links = fields.occurrenceLinks ?? [];

  const button = (url: string, label: string, color: string) =>
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 22px;margin-right:12px;border-radius:6px;background:${color};color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(label)}</a>`;

  const html = `
      <h2>${escapeHtml(heading)}</h2>

      <p>${escapeHtml(fields.organizerName)} invited you to a meeting${
        fields.optional ? " as an <strong>optional participant</strong>" : ""
      }.</p>
${fields.optional ? `
      <p>${escapeHtml(OPTIONAL_NOTE)}</p>
` : ""}${details
  .map(
    ([label, value]) => `
      <p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`
  )
  .join("")}
${fields.seriesNote ? `\n      <p>${escapeHtml(fields.seriesNote)}</p>\n` : ""}${
  fields.joinUrl
    ? `
      <p>${joinButton(fields.joinUrl)}</p>

      <p>Join link: <a href="${escapeHtml(fields.joinUrl)}">${escapeHtml(fields.joinUrl)}</a></p>
${
  links.length > 1
    ? `
      <p><strong>Join links (one Teams meeting per occurrence):</strong></p>

      <ul>
        ${links
          .map(
            (l) =>
              `<li>${escapeHtml(withWeekday(l.date))} - <a href="${escapeHtml(l.joinUrl)}">Join Meeting</a></li>`
          )
          .join("\n        ")}
      </ul>
`
    : ""
}`
    : ""
}
      <p style="margin-top:24px">
        ${button(fields.acceptUrl, "Accept", "#16a34a")}
        ${button(fields.declineUrl, "Decline", "#dc2626")}
      </p>

      <p>You will be asked to confirm your answer. You can answer once.</p>

      <p>Calendar invite attached.</p>
    `;

  const text = [
    heading,
    "",
    `${fields.organizerName} invited you to a meeting${
      fields.optional ? " as an optional participant" : ""
    }.`,
    ...(fields.optional ? ["", OPTIONAL_NOTE] : []),
    "",
    ...details.map(([label, value]) => `${label}: ${value}`),
    ...(fields.seriesNote ? ["", fields.seriesNote] : []),
    ...(fields.joinUrl ? ["", `Join Meeting: ${fields.joinUrl}`] : []),
    ...(links.length > 1
      ? [
          "",
          "Join links (one Teams meeting per occurrence):",
          ...links.map((l) => `- ${withWeekday(l.date)}: ${l.joinUrl}`),
        ]
      : []),
    "",
    `Accept: ${fields.acceptUrl}`,
    `Decline: ${fields.declineUrl}`,
    "",
    "You will be asked to confirm your answer. You can answer once.",
    "Calendar invite attached.",
  ].join("\n");

  return {
    subject: `${heading} - ${sanitizeHeaderValue(fields.title)}`,
    html,
    text,
  };
}

export async function sendInvitationEmail(
  to: string,
  fields: InvitationFields
) {
  const identity = fields.calendar
    ? { ...fields.calendar, location: fields.roomName || undefined }
    : undefined;

  const calendarInvite = await generateCalendarInvite(
    fields.title,
    fields.meetingDate,
    fields.startTime,
    fields.endTime,
    fields.joinUrl,
    {
      identity,
      method: "REQUEST",
      organizer: identity ? calendarOrganizer() : undefined,
    }
  );

  const { subject, html, text } = renderInvitationEmail(fields);

  return getTransporter().sendMail({
    from: getMailSender(),
    to,
    subject,
    html,
    text,
    attachments: [icsAttachment(calendarInvite, "REQUEST")],
  });
}
