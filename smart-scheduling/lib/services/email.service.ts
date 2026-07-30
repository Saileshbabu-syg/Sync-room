import nodemailer from "nodemailer";

import { generateCalendarInvite }
from "./calendar.service";

const transporter =
  nodemailer.createTransport({
    service: "gmail",

    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });

export async function sendMeetingEmail(
  to: string,
  title: string,
  meetingDate: string,
  startTime: string,
  endTime: string
) {

  const calendarInvite =
    await generateCalendarInvite(
      title,
      meetingDate,
      startTime,
      endTime
    );

  await transporter.sendMail({
    from: process.env.EMAIL_USER,

    to,

    subject:
      `Meeting Scheduled - ${title}`,

    html: `
      <h2>Meeting Scheduled</h2>

      <p><strong>Title:</strong> ${title}</p>

      <p><strong>Date:</strong> ${meetingDate}</p>

      <p><strong>Start Time:</strong> ${startTime}</p>

      <p><strong>End Time:</strong> ${endTime}</p>

      <p>
        Calendar invite attached.
      </p>
    `,

    attachments: [
      {
        filename:
          "meeting-invite.ics",

        content:
          calendarInvite,

        contentType:
          "text/calendar",
      },
    ],
  });
}