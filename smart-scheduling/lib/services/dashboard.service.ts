import { db } from "@/db";
import { nowInAppTimezone } from "@/lib/time";

import { meeting } from "@/db/schema";
import { room } from "@/db/schema";
import { meetingStatuses } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";

import {
  and,
  asc,
  eq,
  sql,
} from "drizzle-orm";

export async function getUpcomingMeeting(
  employeeId: number
) {

  const today = nowInAppTimezone().date;

  const currentTime =
    nowInAppTimezone().time;

  const meetings = await db

    .select({

      meetingId: meeting.meeting_id,

      title: meeting.title,

      meetingDate:
        meeting.meeting_date,

      startTime:
        meeting.start_time,

      endTime:
        meeting.end_time,

      participantCount:
        meeting.participantCount,

      roomName:
        room.room_name,

    })

    .from(meeting)

    .leftJoin(
      room,
      eq(
        room.room_id,
        meeting.room_id
      )
    )

    .leftJoin(
      meetingStatuses,
      eq(
        meetingStatuses.meetingStatusId,
        meeting.meetingStatusId
      )
    )

    .where(

      and(

        eq(
          meeting.organizerEmployeeId,
          employeeId
        ),

        eq(
          meeting.meetingStatusId,
          MEETING_STATUS.SCHEDULED
        ),

        sql`
(
meeting.meeting_date > ${today}

OR

(
meeting.meeting_date = ${today}

AND

meeting.start_time >= ${currentTime}
)
)
`

      )

    )

    .orderBy(

      asc(
        meeting.meeting_date
      ),

      asc(
        meeting.start_time
      )

    )

    .limit(1);

  return meetings[0] ?? null;

}

export async function getTodayMeetings(
  employeeId: number
) {

  const today = nowInAppTimezone().date;

  return await db

    .select({

      meetingId: meeting.meeting_id,

      title: meeting.title,

      meetingDate:
        meeting.meeting_date,

      startTime:
        meeting.start_time,

      endTime:
        meeting.end_time,

      participantCount:
        meeting.participantCount,

      roomName:
        room.room_name,

    })

    .from(meeting)

    .leftJoin(
      room,
      eq(
        room.room_id,
        meeting.room_id
      )
    )

    .leftJoin(
      meetingStatuses,
      eq(
        meetingStatuses.meetingStatusId,
        meeting.meetingStatusId
      )
    )

    .where(

      and(

        eq(
          meeting.organizerEmployeeId,
          employeeId
        ),

        eq(
          meeting.meeting_date,
          today
        ),

        eq(
          meeting.meetingStatusId,
          MEETING_STATUS.SCHEDULED
        )

      )

    )

    .orderBy(
      asc(meeting.start_time)
    );

}