import { createEvent } from "ics";

export async function generateCalendarInvite(
  title: string,
  meetingDate: string,
  startTime: string,
  endTime: string
) {
  const [year, month, day] =
    meetingDate.split("-").map(Number);

  const [startHour, startMinute] =
    startTime.split(":").map(Number);

  const [endHour, endMinute] =
    endTime.split(":").map(Number);

  const { error, value } = createEvent({
    title,

    start: [
      year,
      month,
      day,
      startHour,
      startMinute,
    ],

    end: [
      year,
      month,
      day,
      endHour,
      endMinute,
    ],

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