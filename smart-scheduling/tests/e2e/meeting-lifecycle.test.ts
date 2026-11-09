import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { meeting, recurrence_frequency_master } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { createBooking } from "@/lib/services/booking.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { startApp, type App } from "./harness";

// Phase 4 over HTTP: move a scheduled meeting (B-04), series edit / cancel by
// scope (H-1), the series end date (L-2), organizer-or-Admin only (B-10).

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3202);
});

after(() => app?.stop());

async function series(start: number, title = "Standup") {
  const [weekly] = await db
    .select()
    .from(recurrence_frequency_master)
    .where(eq(recurrence_frequency_master.frequency_name, "WEEKLY"));

  const { recurringMeetingId } = await createRecurringMeeting({
    title,
    room_id: f.rooms.alpha.room_id,
    meeting_date: dateFromToday(start),
    start_time: "09:00",
    end_time: "09:30",
    organizerEmployeeId: f.users.bob.employeeId,
    organizerRole: "Employee",
    participantCount: 1,
    meetingTypeId: f.types.team,
    frequency_id: weekly.frequency_id,
    occurrence_count: 4,
    notify: false,
  });

  return (
    await db
      .select()
      .from(meeting)
      .where(eq(meeting.recurringMeetingId, recurringMeetingId))
      .orderBy(asc(meeting.meeting_date))
  ).map((m) => m.meeting_id);
}

const status = async (id: number) =>
  (await db.select().from(meeting).where(eq(meeting.meeting_id, id)))[0].meetingStatusId;

describe("moving a scheduled meeting (B-04, B-10)", () => {
  it("the organizer can move it through the reschedule route; others get 403", async () => {
    const { meetings: [m] } = await createBooking({
      title: "One-off",
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [dateFromToday(9)],
      startTime: "13:00",
      endTime: "14:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 1,
      meetingTypeId: f.types.team,
      notify: false,
    });

    const body = { room_id: f.rooms.beta.room_id, meeting_date: dateFromToday(10), start_time: "13:00", end_time: "13:30" };

    assert.equal((await app.call("PATCH", `/api/meetings/reschedule/${m.meeting_id}`, { as: f.users.carol, body })).status, 403);

    const ok = await app.call("PATCH", `/api/meetings/reschedule/${m.meeting_id}`, { as: f.users.bob, body });
    assert.equal(ok.status, 200, ok.text);

    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, m.meeting_id));
    assert.deepEqual([row.room_id, row.meeting_date, row.ics_sequence], [f.rooms.beta.room_id, dateFromToday(10), 1]);
  });
});

describe("series by scope (H-1)", () => {
  it("cancel ?scope=following cancels this and later occurrences only", async () => {
    const ids = await series(14);

    const res = await app.call("PATCH", `/api/meetings/cancel/${ids[2]}?scope=following`, { as: f.users.bob });
    assert.equal(res.status, 200, res.text);

    assert.deepEqual(await Promise.all(ids.map(status)), [
      MEETING_STATUS.SCHEDULED,
      MEETING_STATUS.SCHEDULED,
      MEETING_STATUS.CANCELLED,
      MEETING_STATUS.CANCELLED,
    ]);

    assert.equal((await app.call("PATCH", `/api/meetings/cancel/${ids[0]}?scope=everything`, { as: f.users.bob })).status, 400);
  });

  it("edit with scope=series renames every upcoming occurrence; another employee gets 403", async () => {
    const ids = await series(42, "Retro");

    assert.equal(
      (await app.call("PATCH", `/api/meetings/edit/${ids[0]}`, { as: f.users.carol, body: { title: "Hijack", scope: "series" } })).status,
      403
    );

    const res = await app.call("PATCH", `/api/meetings/edit/${ids[1]}`, { as: f.users.bob, body: { title: "Retro (new format)", scope: "series" } });
    assert.equal(res.status, 200, res.text);

    const titles = (await db.select().from(meeting)).filter((m) => ids.includes(m.meeting_id)).map((m) => m.title);
    assert.deepEqual([...new Set(titles)], ["Retro (new format)"]);
  });

  it("GET/PATCH /api/meetings/series/:id shows the pattern and shortens the series", async () => {
    const ids = await series(70, "Sync");

    const details = await app.call("GET", `/api/meetings/series/${ids[0]}`, { as: f.users.bob });
    assert.equal(details.status, 200, details.text);
    const body = JSON.parse(details.text) as { series: { frequency: string; occurrences: unknown[]; skippedDates: string[] } };
    assert.equal(body.series.frequency, "WEEKLY");
    assert.equal(body.series.occurrences.length, 4);

    assert.equal((await app.call("GET", `/api/meetings/series/${ids[0]}`, { as: f.users.carol })).status, 403);

    const shorter = await app.call("PATCH", `/api/meetings/series/${ids[0]}`, { as: f.users.bob, body: { end_date: dateFromToday(77) } });
    assert.equal(shorter.status, 200, shorter.text);
    assert.deepEqual((await Promise.all(ids.map(status))).filter((s) => s === MEETING_STATUS.CANCELLED).length, 2);
  });
});
