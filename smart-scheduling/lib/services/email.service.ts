import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import {
  generateCalendarInvite,
  generateSeriesCalendarInvite,
} from "./calendar.service";
import type { MeetingEmailSeries } from "./meeting-series.service";
import { APP_TIMEZONE } from "@/lib/constants";
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
  // room or time ("YYYY-MM-DD HH:mm"). Undefined once it has been cancelled.
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
};

type MeetingEmailFields = {
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  kind?: MeetingEmailKind;
} & MeetingEmailExtras;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "2026-12-01" -> "2026-12-01 (Tue)". Dates are wall-clock dates in
// APP_TIMEZONE (as stored and as shown in the app); the weekday is computed
// from the date alone, so no timezone conversion can shift it.
function withWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return Number.isNaN(day) ? date : `${date} (${WEEKDAYS[day]})`;
}

function renderSingle({
  title,
  meetingDate,
  startTime,
  endTime,
  kind = "scheduled",
  bump,
  preemption,
}: MeetingEmailFields) {
  // A bumped meeting is either waiting for its organizer to change it (it has
  // a deadline) or already cancelled.
  const cancelledByBump = kind === "bumped" && !bump?.deadline;
  const heading = cancelledByBump ? HEADINGS.cancelled : HEADINGS[kind];
  // Neither a cancellation nor a pending meeting carries an invite: a new .ics
  // would add a stray event for a slot the meeting no longer holds.
  const hasInvite =
    kind !== "cancelled" && kind !== "bumped" && kind !== "preempted";

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

  const html = `
      <h2>${escapeHtml(heading)}</h2>
${bumpLines.map((l) => `
      <p>${escapeHtml(l)}</p>`).join("")}

      <p><strong>Title:</strong> ${escapeHtml(title)}</p>

      <p><strong>Date:</strong> ${escapeHtml(meetingDate)}</p>

      <p><strong>Start Time:</strong> ${escapeHtml(startTime)}</p>

      <p><strong>End Time:</strong> ${escapeHtml(endTime)}</p>
${
  hasInvite
    ? `
      <p>
        Calendar invite attached.
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
    `Start Time: ${startTime}`,
    `End Time: ${endTime}`,
    ...(hasInvite ? ["", "Calendar invite attached."] : []),
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
  }: MeetingEmailFields,
  series: MeetingEmailSeries
) {
  const heading = SERIES_HEADINGS[kind];
  const count = series.occurrences.length;
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
            `${withWeekday(meetingDate)}, ${startTime} - ${endTime}`,
          ],
        ] as [string, string][])
      : []),
    ...(roomName ? ([["Room", roomName]] as [string, string][]) : []),
    ...(organizerName
      ? ([["Organizer", organizerName]] as [string, string][])
      : []),
    ["Repeats", series.frequency],
    ["Series start", withWeekday(series.startDate)],
    ["Series end", withWeekday(series.endDate)],
    ["Time zone", APP_TIMEZONE],
    ["Confirmed occurrences", String(count)],
  ];

  const lines = series.occurrences.map(
    (o) => `${withWeekday(o.date)}, ${o.startTime} - ${o.endTime}`
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
        ${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("\n        ")}
      </ol>
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
    ...lines.map((l, i) => `${i + 1}. ${l}`),
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
  const calendarInvite =
    kind === "cancelled" || kind === "bumped" || kind === "preempted"
      ? null
      : extras.series && kind !== "reminder"
        ? await generateSeriesCalendarInvite(
            title,
            extras.series.occurrences,
            extras.roomName
          )
        : await generateCalendarInvite(title, meetingDate, startTime, endTime);

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

    to,

    subject,

    html,

    text,

    attachments: calendarInvite
      ? [
          {
            filename: "meeting-invite.ics",

            content: calendarInvite,

            contentType: "text/calendar",
          },
        ]
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
    ["Start Time", fields.startTime],
    ["End Time", fields.endTime],
  ];

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
${fields.seriesNote ? `\n      <p>${escapeHtml(fields.seriesNote)}</p>\n` : ""}
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
  const calendarInvite = await generateCalendarInvite(
    fields.title,
    fields.meetingDate,
    fields.startTime,
    fields.endTime
  );

  const { subject, html, text } = renderInvitationEmail(fields);

  return getTransporter().sendMail({
    from: getMailSender(),
    to,
    subject,
    html,
    text,
    attachments: [
      {
        filename: "meeting-invite.ics",
        content: calendarInvite,
        contentType: "text/calendar",
      },
    ],
  });
}
