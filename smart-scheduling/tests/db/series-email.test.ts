import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { meeting, notifications } from "@/db/schema";
import { MEETING_STATUS } from "@/lib/constants";
import { computeOccurrenceDates } from "@/lib/recurrence";
import { createBooking } from "@/lib/services/booking.service";
import {
  deliverNotification,
  processPendingNotifications,
} from "@/lib/services/notification.service";
import { createRecurringMeeting } from "@/lib/services/recurring-meeting.service";

import {
  captureMail,
  dateFromToday,
  seedFixtures,
  type Fixtures,
} from "../helpers/fixtures";

// Booking -> recurrence -> database -> outbox -> e-mail, end to end, with a
// mocked transport (nothing is sent).

let f: Fixtures;
let mail: ReturnType<typeof captureMail>;

before(async () => {
  f = await seedFixtures();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE meeting_audit_logs, reminder_logs, notifications,
      meeting_attendees, meeting, recurring_meetings RESTART IDENTITY CASCADE
  `);
  mail = captureMail();
});

after(() => mail?.restore());

const START = () => dateFromToday(7);

const series = (overrides = {}) => ({
  title: "Standup",
  room_id: f.rooms.alpha.room_id,
  meeting_date: START(),
  start_time: "10:00",
  end_time: "10:30",
  organizerEmployeeId: f.users.bob.employeeId,
  organizerRole: "Employee",
  participantCount: 2,
  meetingTypeId: f.types.team,
  participantEmployeeIds: [f.users.carol.employeeId],
  frequency_id: 2,
  occurrence_count: 4,
  notify: false,
  ...overrides,
});

const waitFor = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const notificationRow = async () => (await db.select().from(notifications))[0];

describe("recurring booking confirmation e-mail", () => {
  it("one e-mail to every attendee lists all occurrences with their times", async () => {
    await createRecurringMeeting(series({ notify: true }));

    assert.ok(await waitFor(async () => (await notificationRow())?.status === "SENT"));
    assert.equal((await db.select().from(notifications)).length, 1);
    assert.equal(mail.sent.length, 1);

    const [m] = mail.sent;
    const dates = computeOccurrenceDates(START(), 2, 4);

    assert.equal(m.from, process.env.EMAIL_FROM);
    assert.ok(m.to.includes(f.users.bob.email));
    assert.ok(m.to.includes(f.users.carol.email));
    assert.match(m.subject, /^Recurring Meeting Scheduled - Standup$/);

    dates.forEach((date, i) =>
      assert.ok(m.text.includes(`${i + 1}. ${date} (`) && m.text.includes("10:00:00 - 10:30:00"))
    );
    assert.ok(m.text.includes(`Series start: ${dates[0]}`));
    assert.ok(m.text.includes(`Series end: ${dates[3]}`));
    assert.ok(m.text.includes("Repeats: Weekly"));
    assert.ok(m.text.includes("Organizer: Bob Employee"));
    assert.ok(m.text.includes(`Room: ${f.rooms.alpha.room_name}`));
    assert.equal((m.ics.match(/BEGIN:VEVENT/g) ?? []).length, 4);
  });

  it("the e-mail matches exactly what was saved when dates were skipped", async () => {
    const dates = computeOccurrenceDates(START(), 2, 4);

    await createRecurringMeeting(series({ skip_dates: [dates[1]] }));
    const n = await notificationRow();

    assert.equal(await deliverNotification(n.notification_id), "SENT");

    const [m] = mail.sent;
    const saved = (await db.select().from(meeting)).map((r) => r.meeting_date).sort();

    assert.deepEqual(saved, [dates[0], dates[2], dates[3]]);
    assert.ok(m.text.includes("Confirmed occurrences: 3"));
    assert.ok(m.text.includes("Skipped dates (not booked):"));
    assert.ok(m.text.includes(`- ${dates[1]} (`));
    assert.ok(!m.text.includes(`2. ${dates[1]}`));
    assert.equal((m.ics.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  });

  it("a mail outage keeps the booking, and the retry sends exactly one complete e-mail", async () => {
    mail.setFailures(100);

    await createRecurringMeeting(series({ notify: true }));
    await waitFor(async () => (await notificationRow())?.attempts === 1);

    assert.equal((await db.select().from(meeting)).length, 4, "booking is unaffected");
    assert.equal((await notificationRow()).status, "PENDING");
    assert.equal(mail.sent.length, 0);

    mail.setFailures(0);
    assert.equal((await processPendingNotifications(0)).SENT, 1);
    assert.equal((await processPendingNotifications(0)).SENT, 0, "no second send");

    assert.equal(mail.sent.length, 1);
    assert.equal((mail.sent[0].ics.match(/BEGIN:VEVENT/g) ?? []).length, 4);
    assert.equal((await notificationRow()).status, "SENT");
  });

  it("racing workers still send the series e-mail once", async () => {
    await createRecurringMeeting(series());
    const n = await notificationRow();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => deliverNotification(n.notification_id))
    );

    assert.equal(results.filter((r) => r === "SENT").length, 1);
    assert.equal(mail.sent.length, 1);
  });

  it("occurrences cancelled before delivery are reported as cancelled, not confirmed", async () => {
    const { meetings } = await createRecurringMeeting(series());
    const dates = meetings.map((m) => m.meeting_date);

    await db
      .update(meeting)
      .set({ meetingStatusId: MEETING_STATUS.CANCELLED })
      .where(eq(meeting.meeting_id, meetings[2].meeting_id));

    await deliverNotification((await notificationRow()).notification_id);

    const [m] = mail.sent;
    assert.ok(m.text.includes("Confirmed occurrences: 3"));
    assert.ok(m.text.includes("Cancelled occurrences:"));
    assert.ok(m.text.includes(`- ${dates[2]} (`));
    assert.ok(!m.text.includes(`3. ${dates[2]}`));
    assert.equal((m.ics.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  });

  it("sends nothing when every occurrence was cancelled before delivery", async () => {
    await createRecurringMeeting(series());

    await db.update(meeting).set({ meetingStatusId: MEETING_STATUS.CANCELLED });

    const n = await notificationRow();
    assert.equal(await deliverNotification(n.notification_id), "SKIPPED");
    assert.equal(mail.sent.length, 0);
    assert.equal((await notificationRow()).status, "SKIPPED");
  });
});

describe("one-time booking e-mail is unchanged", () => {
  it("uses the single-date format from the same sender", async () => {
    await createBooking({
      title: "Planning",
      roomId: f.rooms.alpha.room_id,
      occurrenceDates: [START()],
      startTime: "10:00",
      endTime: "11:00",
      organizerEmployeeId: f.users.bob.employeeId,
      organizerRole: "Employee",
      participantCount: 2,
      meetingTypeId: f.types.team,
      participantEmployeeIds: [f.users.carol.employeeId],
      notify: false,
    });

    await deliverNotification((await notificationRow()).notification_id);

    const [m] = mail.sent;
    assert.equal(m.subject, "Meeting Scheduled - Planning");
    assert.equal(m.from, process.env.EMAIL_FROM);
    assert.ok(m.text.includes(`Date: ${START()}`));
    assert.ok(m.text.includes("Start Time: 10:00:00"));
    assert.ok(!m.text.includes("Recurring"));
    assert.equal((m.ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  });
});

describe("cancellation e-mail", () => {
  it("a queued cancellation notification sends one cancelled e-mail to the attendees", async () => {
    const { meetings } = await createRecurringMeeting(series());
    const { queueMeetingNotification } = await import(
      "@/lib/services/notification.service"
    );

    const id = await queueMeetingNotification(db, meetings[1].meeting_id, "CANCELLED");

    assert.equal(await deliverNotification(id), "SENT");
    assert.equal(await deliverNotification(id), "SKIPPED", "never sent twice");

    const [m] = mail.sent;
    assert.equal(m.subject, "Meeting Cancelled - Standup");
    assert.equal(m.from, process.env.EMAIL_FROM);
    assert.ok(m.to.includes(f.users.carol.email));
    assert.ok(m.text.includes(`Date: ${meetings[1].meeting_date}`));
  });
});
