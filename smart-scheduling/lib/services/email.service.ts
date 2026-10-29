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

function createDefaultTransport(): Transporter {
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
  return parseSender(process.env.EMAIL_FROM);
}

// Everything wrong with the e-mail configuration, as readable messages, for a
// startup check. Never includes a value, only names. Empty when sending can
// work.
export function emailConfigProblems(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const problems: string[] = [];

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
  | "cancelled";

const HEADINGS: Record<MeetingEmailKind, string> = {
  scheduled: "Meeting Scheduled",
  updated: "Meeting Updated",
  reminder: "Meeting Reminder",
  cancelled: "Meeting Cancelled",
};

const SERIES_HEADINGS: Record<MeetingEmailKind, string> = {
  scheduled: "Recurring Meeting Scheduled",
  updated: "Recurring Meeting Updated",
  reminder: "Recurring Meeting Reminder",
  cancelled: "Recurring Meeting Cancelled",
};

// Extra details used for a recurring series. Without `series` the message is
// the one-date format.
export type MeetingEmailExtras = {
  roomName?: string;
  organizerName?: string;
  series?: MeetingEmailSeries;
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
}: MeetingEmailFields) {
  const heading = HEADINGS[kind];
  // A cancellation carries no invite: a new .ics would add a stray event
  // instead of removing the original one.
  const hasInvite = kind !== "cancelled";

  const html = `
      <h2>${escapeHtml(heading)}</h2>

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
  { title, roomName, organizerName, kind = "scheduled" }: MeetingEmailFields,
  series: MeetingEmailSeries
) {
  const heading = SERIES_HEADINGS[kind];
  const count = series.occurrences.length;

  const details: [string, string][] = [
    ["Title", title],
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
        Calendar invite attached (one event per occurrence).
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
    "Calendar invite attached (one event per occurrence).",
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
    kind === "cancelled"
      ? null
      : extras.series
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
