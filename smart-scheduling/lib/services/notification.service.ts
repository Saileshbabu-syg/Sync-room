import {
  getMeetingDetails,
  getMeetingAttendees,
} from "./reminder.service";

import {
  sendMeetingEmail,
} from "./email.service";

export async function notifyMeetingBooked(
  meetingId: number
) {

  const meetingDetails =
    await getMeetingDetails(
      meetingId
    );

  if (!meetingDetails) {
    throw new Error(
      "Meeting not found"
    );
  }

  const attendees =
    await getMeetingAttendees(
      meetingId
    );

  for (const attendee of attendees) {

    if (!attendee.email) {
      continue;
    }

    await sendMeetingEmail(
      attendee.email,
      meetingDetails.title,
      String(
        meetingDetails.meeting_date
      ),
      String(
        meetingDetails.start_time
      ),
      String(
        meetingDetails.end_time
      )
    );
  }
}