import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { db } from "@/db";
import { meeting, meeting_attendees } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import {
  countMyBookingsByTab,
  isBookingTab,
  listMyBookings,
  listMyBookingsPage,
} from "@/lib/services/my-bookings.service";

import { seedFixtures, type Fixtures } from "../helpers/fixtures";

// Phase 6 D-09 / D-10: My Bookings is paged and counted on the server, and the
// tabs are defined by status ids.

let f: Fixtures;

beforeEach(async () => {
  f = await seedFixtures();
});

let hour = 6;

// A meeting organized by Bob (or with Carol as an attendee), each in its own
// slot so nothing overlaps.
async function add(status: number, date = "2031-04-01", attendee = false) {
  const start = `${String(hour).padStart(2, "0")}:00`;
  const end = `${String(hour).padStart(2, "0")}:30`;

  hour = hour >= 20 ? 6 : hour + 1;

  const [row] = await db
    .insert(meeting)
    .values({
      title: `M${status}`,
      room_id: f.rooms.alpha.room_id,
      meeting_date: date,
      organizerEmployeeId: attendee ? f.users.manager.employeeId : f.users.bob.employeeId,
      participantCount: 1,
      meetingTypeId: f.types.team,
      meetingStatusId: status,
      start_time: start,
      end_time: end,
    })
    .returning();

  if (attendee) {
    await db.insert(meeting_attendees).values({ meeting_id: row.meeting_id, employee_id: f.users.bob.employeeId });
  }

  return row.meeting_id;
}

const bob = () => f.users.bob.employeeId;

describe("My Bookings tabs and paging", () => {
  it("counts each tab by status id; pending reschedule belongs to Scheduled", async () => {
    await add(MEETING_STATUS.SCHEDULED);
    await add(MEETING_STATUS.PENDING_RESCHEDULE);
    await add(MEETING_STATUS.COMPLETED, "2031-04-02");
    await add(MEETING_STATUS.CANCELLED, "2031-04-02");
    await add(MEETING_STATUS.CANCELLED, "2031-04-03");
    await add(MEETING_STATUS.PREEMPTED, "2031-04-03");
    await add(MEETING_STATUS.SCHEDULED, "2031-04-04", true); // as an attendee

    assert.deepEqual(await countMyBookingsByTab(bob()), { scheduled: 3, completed: 1, replaced: 1, cancelled: 2 });
    assert.deepEqual(await countMyBookingsByTab(bob(), "2031-04-02"), { scheduled: 0, completed: 1, replaced: 0, cancelled: 1 });

    const scheduled = await listMyBookingsPage(bob(), { tab: "scheduled", page: 1, pageSize: 10 });
    assert.deepEqual(
      scheduled.map((m) => m.meetingStatusId).sort(),
      [MEETING_STATUS.SCHEDULED, MEETING_STATUS.SCHEDULED, MEETING_STATUS.PENDING_RESCHEDULE].sort()
    );

    // Someone else sees none of Bob's.
    assert.deepEqual(await countMyBookingsByTab(f.users.carol.employeeId), { scheduled: 0, completed: 0, replaced: 0, cancelled: 0 });
  });

  it("pages are disjoint, complete and newest first, even when meetings share a date and time slot", async () => {
    const created: number[] = [];

    for (let day = 1; day <= 5; day++) {
      for (let i = 0; i < 5; i++) {
        created.push(await add(MEETING_STATUS.CANCELLED, `2031-05-0${day}`));
      }
    }

    const seen: number[] = [];

    for (let page = 1; page <= 3; page++) {
      const rows = await listMyBookingsPage(bob(), { tab: "cancelled", page, pageSize: 10 });

      assert.equal(rows.length, page < 3 ? 10 : 5);
      seen.push(...rows.map((r) => r.meetingId));
    }

    assert.equal(new Set(seen).size, 25, "no meeting on two pages");
    assert.deepEqual([...seen].sort((a, b) => a - b), [...created].sort((a, b) => a - b), "none missing");

    const firstPage = await listMyBookingsPage(bob(), { tab: "cancelled", page: 1, pageSize: 10 });
    assert.equal(firstPage[0].meetingDate, "2031-05-05", "newest first");

    assert.deepEqual(await listMyBookingsPage(bob(), { tab: "cancelled", page: 4, pageSize: 10 }), []);
  });

  it("keeps the unpaged list for existing callers and carries the Teams state", async () => {
    const id = await add(MEETING_STATUS.SCHEDULED);

    const [row] = await listMyBookings(bob());

    assert.equal(row.meetingId, id);
    assert.equal(row.onlineRequested, false);
    assert.equal(row.onlineStatus, "NONE");
  });

  it("only known tab ids are accepted", () => {
    for (const tab of ["scheduled", "completed", "replaced", "cancelled"]) assert.ok(isBookingTab(tab));
    for (const tab of ["Scheduled", "toString", "__proto__", "", undefined, 1]) assert.ok(!isBookingTab(tab));
  });
});
