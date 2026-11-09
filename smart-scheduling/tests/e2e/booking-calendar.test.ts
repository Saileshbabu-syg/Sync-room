import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { meeting, recurrence_frequency_master } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { createBooking } from "@/lib/services/booking.service";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { startApp, type App } from "./harness";

// Phase 3 over HTTP: the 15-minute minimum on every route that sets a time
// (B-01), and the calendar version on edits (H-2).

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3201);
});

after(() => app?.stop());

const sequenceOf = async (id: number) =>
  (await db.select({ s: meeting.ics_sequence }).from(meeting).where(eq(meeting.meeting_id, id)))[0].s;

describe("15-minute minimum on every route (B-01)", () => {
  const single = (end: string) => ({
    title: "Standup",
    meeting_date: dateFromToday(10),
    room_id: f.rooms.alpha.room_id,
    participant_count: 1,
    meeting_type_id: f.types.team,
    start_time: "09:00",
    end_time: end,
  });

  it("single booking: 14 minutes is 400, 15 minutes is booked", async () => {
    const short = await app.call("POST", "/api/meetings/booking", { as: f.users.bob, body: single("09:14") });
    assert.equal(short.status, 400);
    assert.match(short.text, /at least 15 minutes/);

    const ok = await app.call("POST", "/api/meetings/booking", { as: f.users.bob, body: single("09:15") });
    assert.equal(ok.status, 201, ok.text);
  });

  it("recurring booking: 14 minutes is 400", async () => {
    const [weekly] = await db
      .select()
      .from(recurrence_frequency_master)
      .where(eq(recurrence_frequency_master.frequency_name, "WEEKLY"));

    const res = await app.call("POST", "/api/meetings/recurring", {
      as: f.users.bob,
      body: {
        title: "Standup",
        room_id: f.rooms.beta.room_id,
        meeting_date: dateFromToday(11),
        start_time: "09:00",
        end_time: "09:14",
        participantCount: 1,
        meetingTypeId: f.types.team,
        frequency_id: weekly.frequency_id,
        occurrence_count: 2,
      },
    });

    assert.equal(res.status, 400);
    assert.match(res.text, /at least 15 minutes/);
  });

  it("reschedule: 14 minutes is 400 and the meeting is unchanged", async () => {
    const { meetings: [m] } = await createBooking({
      title: "Bumped",
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [dateFromToday(12)],
      startTime: "14:00",
      endTime: "15:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 1,
      meetingTypeId: f.types.team,
      notify: false,
    });
    await db
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.PENDING_RESCHEDULE })
      .where(eq(meeting.meeting_id, m.meeting_id));

    const res = await app.call("PATCH", `/api/meetings/reschedule/${m.meeting_id}`, {
      as: f.users.bob,
      body: { room_id: f.rooms.beta.room_id, meeting_date: dateFromToday(13), start_time: "10:00", end_time: "10:14" },
    });

    assert.equal(res.status, 400);
    const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, m.meeting_id));
    assert.equal(row.meeting_date, dateFromToday(12));
    assert.equal(row.meetingStatusId, MEETING_STATUS.PENDING_RESCHEDULE);
  });
});

describe("calendar version on edits (H-2)", () => {
  it("a new title raises it; a headcount change does not", async () => {
    const { meetings: [m] } = await createBooking({
      title: "Planning",
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [dateFromToday(14)],
      startTime: "10:00",
      endTime: "11:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 2,
      meetingTypeId: f.types.team,
      notify: false,
    });

    assert.equal(await sequenceOf(m.meeting_id), 0);

    const headcount = await app.call("PATCH", `/api/meetings/edit/${m.meeting_id}`, {
      as: f.users.bob,
      body: { participantCount: 3 },
    });
    assert.equal(headcount.status, 200, headcount.text);
    assert.equal(await sequenceOf(m.meeting_id), 0);

    const title = await app.call("PATCH", `/api/meetings/edit/${m.meeting_id}`, {
      as: f.users.bob,
      body: { title: "Planning (moved agenda)" },
    });
    assert.equal(title.status, 200, title.text);
    assert.equal(await sequenceOf(m.meeting_id), 1);
  });
});
