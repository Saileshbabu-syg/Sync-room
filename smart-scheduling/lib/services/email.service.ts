import nodemailer, { type Transporter } from "nodemailer";

import { generateCalendarInvite } from "./calendar.service";
import { escapeHtml, sanitizeHeaderValue } from "@/lib/html";

let transporter: Transporter | null = null;

function createDefaultTransport(): Transporter {
  // SMTP_HOST points the app at a local mail sink (Mailpit etc.) instead of
  // Gmail; the automated tests use it so nothing is ever delivered for real.
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 25),
      secure: process.env.SMTP_SECURE === "true",
      ignoreTLS: process.env.SMTP_SECURE !== "true",
    });
  }

  return nodemailer.createTransport({
    service: "gmail",

    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
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

export type MeetingEmailKind = "scheduled" | "updated" | "reminder";

const HEADINGS: Record<MeetingEmailKind, string> = {
  scheduled: "Meeting Scheduled",
  updated: "Meeting Updated",
  reminder: "Meeting Reminder",
};

type MeetingEmailFields = {
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  kind?: MeetingEmailKind;
};

// Every dynamic value is untrusted (titles are typed by any employee), so it
// is HTML-escaped exactly once, here, at the point of interpolation. Header
// values are stripped of line breaks.
export function renderMeetingEmail({
  title,
  meetingDate,
  startTime,
  endTime,
  kind = "scheduled",
}: MeetingEmailFields) {
  const heading = HEADINGS[kind];

  const html = `
      <h2>${escapeHtml(heading)}</h2>

      <p><strong>Title:</strong> ${escapeHtml(title)}</p>

      <p><strong>Date:</strong> ${escapeHtml(meetingDate)}</p>

      <p><strong>Start Time:</strong> ${escapeHtml(startTime)}</p>

      <p><strong>End Time:</strong> ${escapeHtml(endTime)}</p>

      <p>
        Calendar invite attached.
      </p>
    `;

  const text = [
    heading,
    "",
    `Title: ${title}`,
    `Date: ${meetingDate}`,
    `Start Time: ${startTime}`,
    `End Time: ${endTime}`,
    "",
    "Calendar invite attached.",
  ].join("\n");

  return {
    subject: `${heading} - ${sanitizeHeaderValue(title)}`,
    html,
    text,
  };
}

export async function sendMeetingEmail(
  to: string | string[],
  title: string,
  meetingDate: string,
  startTime: string,
  endTime: string,
  kind: MeetingEmailKind = "scheduled"
) {
  const calendarInvite = await generateCalendarInvite(
    title,
    meetingDate,
    startTime,
    endTime
  );

  const { subject, html, text } = renderMeetingEmail({
    title,
    meetingDate,
    startTime,
    endTime,
    kind,
  });

  return getTransporter().sendMail({
    from: process.env.EMAIL_USER,

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
