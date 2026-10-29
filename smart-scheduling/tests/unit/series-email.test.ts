import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { MEETING_STATUS } from "@/lib/constants";
import { computeOccurrenceDates } from "@/lib/recurrence";
import {
  emailConfigProblems,
  getMailSender,
  renderMeetingEmail,
  sendMeetingEmail,
  setMailTransport,
} from "@/lib/services/email.service";
import {
  buildSeriesEmail,
  type MeetingEmailSeries,
} from "@/lib/services/meeting-series.service";
import { captureMail } from "../helpers/fixtures";

const DAILY = 1;
const WEEKLY = 2;
const MONTHLY = 3;

const rowsFor = (
  dates: string[],
  status: number = MEETING_STATUS.SCHEDULED,
  start = "10:00:00",
  end = "11:00:00"
) =>
  dates.map((meeting_date) => ({
    meeting_date,
    start_time: start,
    end_time: end,
    meetingStatusId: status,
  }));

afterEach(() => setMailTransport(null));

describe("one-time meeting e-mail keeps the single-date format", () => {
  it("shows the date and the start and end time", async () => {
    const mail = captureMail();

    await sendMeetingEmail(
      ["a@example.test"],
      "Planning",
      "2026-12-01",
      "10:00:00",
      "11:00:00"
    );

    const [m] = mail.sent;
    assert.equal(m.subject, "Meeting Scheduled - Planning");
    assert.ok(m.html.includes("<strong>Date:</strong> 2026-12-01"));
    assert.ok(m.html.includes("<strong>Start Time:</strong> 10:00:00"));
    assert.ok(m.html.includes("<strong>End Time:</strong> 11:00:00"));
    assert.ok(!m.html.includes("<ol>"));
    assert.equal((m.ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
    assert.match(m.ics, /DTSTART:20261201T043000Z/);
    assert.match(m.ics, /DTEND:20261201T053000Z/);
  });
});

describe("buildSeriesEmail", () => {
  it("weekly: lists every confirmed occurrence in order with first and last dates", () => {
    const dates = computeOccurrenceDates("2026-12-02", WEEKLY, 5);
    const series = buildSeriesEmail(WEEKLY, "WEEKLY", rowsFor([...dates].reverse()))!;

    assert.deepEqual(
      series.occurrences.map((o) => o.date),
      ["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23", "2026-12-30"]
    );
    assert.equal(series.startDate, "2026-12-02");
    assert.equal(series.endDate, "2026-12-30");
    assert.equal(series.frequency, "Weekly");
    assert.deepEqual(series.skippedDates, []);
    assert.deepEqual(series.cancelledDates, []);
    assert.ok(series.occurrences.every((o) => o.startTime === "10:00:00" && o.endTime === "11:00:00"));
  });

  it("daily: runs Monday to Friday and skips the weekend", () => {
    // Fri 4 Dec 2026 + 3 working days -> Mon 7, Tue 8, Wed 9
    const dates = computeOccurrenceDates("2026-12-04", DAILY, 4);
    const series = buildSeriesEmail(DAILY, "DAILY", rowsFor(dates))!;

    assert.deepEqual(series.occurrences.map((o) => o.date), [
      "2026-12-04",
      "2026-12-07",
      "2026-12-08",
      "2026-12-09",
    ]);
    assert.equal(series.frequency, "Daily (Monday to Friday)");
    assert.deepEqual(series.skippedDates, [], "the weekend is not a skipped date");
  });

  it("monthly: clamps to the end of short months exactly like the booking", () => {
    const dates = computeOccurrenceDates("2027-01-31", MONTHLY, 3);
    assert.deepEqual(dates, ["2027-01-31", "2027-02-28", "2027-03-31"]);

    const series = buildSeriesEmail(MONTHLY, "MONTHLY", rowsFor(dates))!;

    assert.deepEqual(series.occurrences.map((o) => o.date), dates);
    assert.equal(series.frequency, "Monthly");
    assert.deepEqual(series.skippedDates, []);
  });

  it("reports a date skipped at booking time (a gap in the saved rows)", () => {
    const all = computeOccurrenceDates("2026-12-02", WEEKLY, 4);
    const booked = all.filter((d) => d !== "2026-12-09");

    const series = buildSeriesEmail(WEEKLY, "WEEKLY", rowsFor(booked))!;

    assert.deepEqual(series.skippedDates, ["2026-12-09"]);
    assert.deepEqual(series.occurrences.map((o) => o.date), [
      "2026-12-02",
      "2026-12-16",
      "2026-12-23",
    ]);
    assert.equal(series.endDate, "2026-12-23", "the end date is the last confirmed date");
  });

  it("does not claim skipped dates when the saved rows are not on the pattern", () => {
    // Monthly series whose first date (Jan 31) was skipped: the pattern cannot
    // be rebuilt from Feb 28, so nothing is reported rather than a wrong date.
    const series = buildSeriesEmail(
      MONTHLY,
      "MONTHLY",
      rowsFor(["2027-02-28", "2027-03-31"])
    )!;

    assert.deepEqual(series.skippedDates, []);
    assert.equal(series.occurrences.length, 2);
  });

  it("cancelled occurrences are not confirmed and are listed separately", () => {
    const dates = computeOccurrenceDates("2026-12-02", WEEKLY, 3);
    const rows = [
      ...rowsFor([dates[0], dates[2]]),
      ...rowsFor([dates[1]], MEETING_STATUS.CANCELLED),
    ];

    const series = buildSeriesEmail(WEEKLY, "WEEKLY", rows)!;

    assert.deepEqual(series.occurrences.map((o) => o.date), [dates[0], dates[2]]);
    assert.deepEqual(series.cancelledDates, [dates[1]]);
    assert.deepEqual(series.skippedDates, [], "a cancelled row is not a skipped date");
  });

  it("the recurrence end date follows the last confirmed occurrence", () => {
    const dates = computeOccurrenceDates("2026-12-02", WEEKLY, 3);
    const rows = [
      ...rowsFor(dates.slice(0, 2)),
      ...rowsFor([dates[2]], MEETING_STATUS.CANCELLED),
    ];

    assert.equal(buildSeriesEmail(WEEKLY, "WEEKLY", rows)!.endDate, dates[1]);
  });

  it("returns null when nothing is confirmed any more", () => {
    assert.equal(
      buildSeriesEmail(
        WEEKLY,
        "WEEKLY",
        rowsFor(["2026-12-02"], MEETING_STATUS.CANCELLED)
      ),
      null
    );
  });

  it("keeps wall-clock dates and times untouched (no timezone shift)", () => {
    // 00:30 and 23:30 are where a UTC conversion of an IST wall-clock value
    // would move the date.
    const series = buildSeriesEmail(
      WEEKLY,
      "WEEKLY",
      rowsFor(["2026-12-02", "2026-12-09"], MEETING_STATUS.SCHEDULED, "00:30:00", "23:30:00")
    )!;

    assert.deepEqual(series.occurrences, [
      { date: "2026-12-02", startTime: "00:30:00", endTime: "23:30:00" },
      { date: "2026-12-09", startTime: "00:30:00", endTime: "23:30:00" },
    ]);
  });
});

describe("recurring meeting e-mail", () => {
  const series: MeetingEmailSeries = {
    frequency: "Weekly",
    startDate: "2026-12-02",
    endDate: "2026-12-23",
    occurrences: ["2026-12-02", "2026-12-16", "2026-12-23"].map((date) => ({
      date,
      startTime: "00:30:00",
      endTime: "23:30:00",
    })),
    skippedDates: ["2026-12-09"],
    cancelledDates: ["2026-12-30"],
  };

  it("contains the details and every confirmed date with its times", async () => {
    const mail = captureMail();

    await sendMeetingEmail(
      ["a@example.test", "b@example.test"],
      "Standup",
      "2026-12-02",
      "00:30:00",
      "23:30:00",
      "scheduled",
      { roomName: "Alpha", organizerName: "Bob Employee", series }
    );

    assert.equal(mail.sent.length, 1, "one message for all attendees");
    const [m] = mail.sent;

    assert.equal(m.subject, "Recurring Meeting Scheduled - Standup");

    for (const part of [
      "Title: Standup",
      "Room: Alpha",
      "Organizer: Bob Employee",
      "Repeats: Weekly",
      "Series start: 2026-12-02 (Wed)",
      "Series end: 2026-12-23 (Wed)",
      "Time zone: Asia/Kolkata",
      "Confirmed occurrences: 3",
      "1. 2026-12-02 (Wed), 00:30:00 - 23:30:00",
      "2. 2026-12-16 (Wed), 00:30:00 - 23:30:00",
      "3. 2026-12-23 (Wed), 00:30:00 - 23:30:00",
      "- 2026-12-09 (Wed)",
      "Cancelled occurrences:",
      "- 2026-12-30 (Wed)",
    ]) {
      assert.ok(m.text.includes(part), `text is missing: ${part}`);
    }

    assert.equal((m.html.match(/<li>/g) ?? []).length, 3 + 1 + 1);
    assert.ok(m.html.includes("Skipped dates"));
  });

  it("attaches one calendar event per confirmed occurrence, at the right times", async () => {
    const mail = captureMail();

    await sendMeetingEmail(
      ["a@example.test"],
      "Standup",
      "2026-12-02",
      "00:30:00",
      "23:30:00",
      "scheduled",
      { roomName: "Alpha", series }
    );

    const { ics } = mail.sent[0];
    assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 3);
    assert.match(ics, /DTSTART:20261201T190000Z/);
    assert.match(ics, /DTEND:20261202T180000Z/);
    assert.match(ics, /DTSTART:20261222T190000Z/);
    assert.ok(!/DTSTART:20261209/.test(ics), "the skipped date has no event");
    assert.match(ics, /LOCATION:Alpha/);
  });

  it("omits the skipped and cancelled sections when there are none", () => {
    const { html, text } = renderMeetingEmail({
      title: "Standup",
      meetingDate: "2026-12-02",
      startTime: "10:00:00",
      endTime: "11:00:00",
      series: { ...series, skippedDates: [], cancelledDates: [] },
    });

    assert.ok(!html.includes("Skipped"));
    assert.ok(!html.includes("Cancelled"));
    assert.ok(!text.includes("Skipped"));
  });

  it("escapes untrusted values and adds no markup beyond the template's", () => {
    const evil = `<script>alert(1)</script>`;
    const { html, subject } = renderMeetingEmail({
      title: evil,
      meetingDate: "2026-12-02",
      startTime: "10:00:00",
      endTime: "11:00:00",
      roomName: evil,
      organizerName: `<img src=x onerror=alert(1)>`,
      series,
    });

    const allowed = ["h2", "p", "strong", "ol", "ul", "li"];
    for (const tag of html.match(/<\/?[a-zA-Z][^>]*>/g) ?? []) {
      const name = /^<\/?([a-zA-Z0-9]+)/.exec(tag)![1].toLowerCase();
      assert.ok(allowed.includes(name), `unexpected tag ${tag}`);
    }
    assert.ok(!html.includes("<script"));
    assert.ok(!/[\r\n]/.test(subject));
  });
});

describe("sender configuration", () => {
  it("every message uses the one configured EMAIL_FROM", async () => {
    const mail = captureMail();

    await sendMeetingEmail(["a@example.test"], "One", "2026-12-01", "10:00:00", "11:00:00");
    await sendMeetingEmail(["a@example.test"], "Two", "2026-12-01", "10:00:00", "11:00:00", "updated");
    await sendMeetingEmail(["a@example.test"], "Three", "2026-12-01", "10:00:00", "11:00:00", "reminder");
    await sendMeetingEmail(
      ["a@example.test"],
      "Four",
      "2026-12-02",
      "10:00:00",
      "11:00:00",
      "scheduled",
      {
        series: {
          frequency: "Weekly",
          startDate: "2026-12-02",
          endDate: "2026-12-02",
          occurrences: [{ date: "2026-12-02", startTime: "10:00:00", endTime: "11:00:00" }],
          skippedDates: [],
          cancelledDates: [],
        },
      }
    );

    assert.equal(mail.sent.length, 4);
    assert.ok(mail.sent.every((m) => m.from === process.env.EMAIL_FROM));
    assert.equal(mail.sent[0].from, "Meeting Rooms <rooms@example.invalid>");
  });

  it("refuses to send when EMAIL_FROM is missing instead of using another address", async () => {
    const mail = captureMail();
    const saved = process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM;

    try {
      assert.throws(() => getMailSender(), /EMAIL_FROM/);
      await assert.rejects(
        sendMeetingEmail(["a@example.test"], "T", "2026-12-01", "10:00:00", "11:00:00"),
        /EMAIL_FROM/
      );
      assert.equal(mail.sent.length, 0);
    } finally {
      process.env.EMAIL_FROM = saved;
    }
  });
});

describe("cancellation e-mail", () => {
  it("uses the same sender, names the cancelled date and carries no calendar invite", async () => {
    const mail = captureMail();

    await sendMeetingEmail(
      ["a@example.test"],
      "Planning",
      "2026-12-01",
      "10:00:00",
      "11:00:00",
      "cancelled"
    );

    const [m] = mail.sent;
    assert.equal(m.subject, "Meeting Cancelled - Planning");
    assert.equal(m.from, process.env.EMAIL_FROM);
    assert.ok(m.text.includes("Date: 2026-12-01"));
    assert.ok(!m.text.includes("Calendar invite"));
    assert.equal(m.ics, "", "no .ics attachment");
  });
});

describe("reminder for an occurrence of a series", () => {
  it("names this meeting, lists the whole series and attaches only its own invite", async () => {
    const mail = captureMail();

    await sendMeetingEmail(
      ["a@example.test"],
      "Standup",
      "2026-12-16",
      "10:00:00",
      "10:30:00",
      "reminder",
      {
        roomName: "Alpha",
        series: {
          frequency: "Weekly",
          startDate: "2026-12-02",
          endDate: "2026-12-23",
          occurrences: ["2026-12-02", "2026-12-16", "2026-12-23"].map((date) => ({
            date,
            startTime: "10:00:00",
            endTime: "10:30:00",
          })),
          skippedDates: [],
          cancelledDates: [],
        },
      }
    );

    const [m] = mail.sent;
    assert.equal(m.subject, "Recurring Meeting Reminder - Standup");
    assert.ok(m.text.includes("This meeting: 2026-12-16 (Wed), 10:00:00 - 10:30:00"));
    assert.ok(m.text.includes("3. 2026-12-23 (Wed)"));
    assert.equal((m.ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  });
});

describe("existing Gmail sender (until the company relay is integrated)", () => {
  it("uses EMAIL_USER as the sender when only EMAIL_USER / EMAIL_PASSWORD are set", () => {
    const keep = { ...process.env };
    delete process.env.EMAIL_FROM;
    delete process.env.SMTP_HOST;
    process.env.EMAIL_USER = "existing@example.invalid";
    process.env.EMAIL_PASSWORD = "not-a-real-password";

    try {
      assert.equal(getMailSender(), "existing@example.invalid");
      assert.deepEqual(emailConfigProblems(), []);
    } finally {
      for (const k of ["EMAIL_FROM", "SMTP_HOST", "EMAIL_USER", "EMAIL_PASSWORD"]) {
        if (keep[k] === undefined) delete process.env[k];
        else process.env[k] = keep[k];
      }
    }
  });
});
