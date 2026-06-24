import { db } from "@/db";

import { meeting } from "@/db/schema/meeting";
import { recurring_meetings } from "@/db/schema/recurring_meetings";

function getNextDate(
  currentDate: Date,
  frequencyId: number
) {
  const nextDate = new Date(currentDate);

  switch (frequencyId) {
    case 1: // Daily
      nextDate.setDate(nextDate.getDate() + 1);
      break;

    case 2: // Weekly
      nextDate.setDate(nextDate.getDate() + 7);
      break;

    case 3: // Monthly
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
  }

  return nextDate;
}

export async function createRecurringMeeting(
  data: {
    title: string;
    room_id: number;
    meeting_date: string;
    start_time: string;
    end_time: string;
    frequency_id: number;
    occurrence_count: number;
  }
) {
  const createdMeetings = [];

  let currentDate = new Date(
    data.meeting_date
  );

  for (
    let i = 0;
    i < data.occurrence_count;
    i++
  ) {
    const insertedMeeting =
      await db
        .insert(meeting)
        .values({
          title: data.title,
          room_id: data.room_id,
          meeting_date:
            currentDate
              .toISOString()
              .split("T")[0],
          start_time: data.start_time,
          end_time: data.end_time,
        })
        .returning();

    createdMeetings.push(
      insertedMeeting[0]
    );

    currentDate = getNextDate(
      currentDate,
      data.frequency_id
    );
  }

  await db
    .insert(recurring_meetings)
    .values({
      meeting_id:
        createdMeetings[0].meeting_id,

      frequency_id:
        data.frequency_id,

      occurrence_count:
        data.occurrence_count,

      recurrence_end_date:
        currentDate
          .toISOString()
          .split("T")[0],
    });

  return createdMeetings;
}