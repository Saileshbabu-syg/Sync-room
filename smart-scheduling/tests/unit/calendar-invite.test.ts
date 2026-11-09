import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  calendarUid,
  generateCalendarInvite,
  generateSeriesCalendarInvite,
} from "@/lib/services/calendar.service";
import { sendMeetingEmail } from "@/lib/services/email.service";
import {
  RECURRENCE_FREQUENCIES,
  UnsupportedFrequencyError,
  computeOccurrenceDates,
  frequencyFromName,
} from "@/lib/recurrence";
import {
  MIN_MEETING_MINUTES,
  bookingWindowEnd,
  isLongEnough,
  isWithinBookingWindow,
} from "@/lib/validations/date-time";
import { createMeetingSchema } from "@/lib/validations/meeting.validator";
import { recurringMeetingSchema } from "@/lib/validations/recurring-meeting";
import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";

import { captureMail, dateFromToday } from "../helpers/fixtures";

// Phase 3: H-2 (calendar identity), B-01 (duration), M-4 (frequencies),
// B-06 / B-07 (booking window, headcount bound).

// Unfolds iCalendar lines (RFC 5545 3.1) and drops DTSTAMP, which is the
// generation time and legitimately differs between two generations.
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
const stable = (ics: string) =>
  unfold(ics)
    .split("\r\n")
    .filter((l) => !l.startsWith("DTSTAMP:"))
    .join("\r\n");
const prop = (ics: string, name: string) =>
  unfold(ics)
    .split("\r\n")
    .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

const identity = { meetingId: 42, sequence: 3, location: "Alpha" };
const organizer = { name: "Meeting Rooms", email: "rooms@example.test" };

describe("calendar identity (H-2)", () => {
  const saved = { AUTH_URL: process.env.AUTH_URL, NEXTAUTH_URL: process.env.NEXTAUTH_URL };

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("the UID is derived from the meeting and the configured host", () => {
    assert.equal(calendarUid(42, { AUTH_URL: "https://rooms.example.com" }), "meeting-42@rooms.example.com");
    assert.equal(calendarUid(42, {}), "meeting-42@meetsched.local");
    assert.equal(calendarUid(42, { AUTH_URL: "not a url" }), "meeting-42@meetsched.local");
  });

  it("is identical every time the invite is generated, and so is the version", async () => {
    const a = await generateCalendarInvite("Standup", "2026-12-01", "10:00", "11:00", undefined, { identity, organizer });
    const b = await generateCalendarInvite("Standup", "2026-12-01", "10:00", "11:00", undefined, { identity, organizer });

    assert.equal(stable(a), stable(b));
    assert.equal(prop(a, "UID"), "UID:meeting-42@meetsched.local");
    assert.equal(prop(a, "SEQUENCE"), "SEQUENCE:3");
  });

  it("an invite or update is a REQUEST with the latest details", async () => {
    const ics = await generateCalendarInvite("Standup", "2026-12-01", "10:00", "11:30", undefined, { identity, organizer });

    assert.equal(prop(ics, "METHOD"), "METHOD:REQUEST");
    assert.equal(prop(ics, "STATUS"), "STATUS:CONFIRMED");
    assert.equal(prop(ics, "LOCATION"), "LOCATION:Alpha");
    // 10:00-11:30 in Asia/Kolkata (UTC+05:30) is 04:30-06:00 UTC.
    assert.equal(prop(ics, "DTSTART"), "DTSTART:20261201T043000Z");
    assert.equal(prop(ics, "DTEND"), "DTEND:20261201T060000Z");
    assert.match(prop(ics, "ORGANIZER") ?? "", /MAILTO:rooms@example.test/);
  });

  it("a cancellation keeps the UID and goes out one version above the current one", async () => {
    const invite = await generateCalendarInvite("Standup", "2026-12-01", "10:00", "11:00", undefined, { identity, organizer });
    const cancel = await generateCalendarInvite("Standup", "2026-12-01", "10:00", "11:00", undefined, {
      identity,
      organizer,
      method: "CANCEL",
    });

    assert.equal(prop(cancel, "METHOD"), "METHOD:CANCEL");
    assert.equal(prop(cancel, "STATUS"), "STATUS:CANCELLED");
    assert.equal(prop(cancel, "UID"), prop(invite, "UID"));
    assert.equal(prop(cancel, "SEQUENCE"), "SEQUENCE:4");
  });

  it("puts the Teams link in the description and the URL, next to the room", async () => {
    const url = "https://teams.microsoft.com/l/meetup-join/abc";
    const ics = await generateCalendarInvite("Standup", "2026-12-01", "10:00", "11:00", url, { identity });

    assert.equal(prop(ics, "DESCRIPTION"), `DESCRIPTION:Join Microsoft Teams Meeting: ${url}`);
    assert.equal(prop(ics, "URL"), `URL:${url}`);
    assert.equal(prop(ics, "LOCATION"), "LOCATION:Alpha / Microsoft Teams Meeting");
  });

  it("escapes text and folds long lines as RFC 5545 requires", async () => {
    const title = `Plan, review; ship\\${"x".repeat(120)}`;
    const ics = await generateCalendarInvite(title, "2026-12-01", "10:00", "11:00", undefined, { identity });

    assert.match(prop(ics, "SUMMARY") ?? "", /^SUMMARY:Plan\\, review\\; ship\\\\x+$/);

    for (const line of ics.split("\r\n")) {
      assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
    }
    // Folded: CRLF followed by one space or tab (both valid, RFC 5545 3.1).
    assert.ok(/\r\n[ \t]/.test(ics), "the long line is folded");
  });

  it("a series is one PUBLISH with an entry per occurrence, each with its own UID and version", async () => {
    const ics = await generateSeriesCalendarInvite(
      "Standup",
      [
        { date: "2026-12-02", startTime: "10:00", endTime: "10:30", meetingId: 7, sequence: 0 },
        { date: "2026-12-09", startTime: "10:00", endTime: "10:30", meetingId: 8, sequence: 2 },
      ],
      "Alpha",
      organizer
    );

    assert.equal(prop(ics, "METHOD"), "METHOD:PUBLISH");
    assert.deepEqual(
      unfold(ics).split("\r\n").filter((l) => l.startsWith("UID:")),
      ["UID:meeting-7@meetsched.local", "UID:meeting-8@meetsched.local"]
    );
    assert.deepEqual(
      unfold(ics).split("\r\n").filter((l) => l.startsWith("SEQUENCE:")),
      ["SEQUENCE:0", "SEQUENCE:2"]
    );
  });
});

describe("calendar part of each e-mail (H-2)", () => {
  const send = (kind: Parameters<typeof sendMeetingEmail>[5], extras: Parameters<typeof sendMeetingEmail>[6] = {}) =>
    sendMeetingEmail(["a@example.test"], "Standup", "2026-12-01", "10:00:00", "11:00:00", kind, {
      roomName: "Alpha",
      calendar: { meetingId: 9, sequence: 1 },
      ...extras,
    });

  it("updates and reminders carry a REQUEST for the same entry, cancellations a CANCEL", async () => {
    const mail = captureMail();

    try {
      await send("updated");
      await send("reminder");
      await send("cancelled");
      await send("preempted");
      await send("bumped", { bump: { claimedBy: "x", roomName: "Alpha" } });
      await send("bumped", { bump: { claimedBy: "x", roomName: "Alpha", deadline: "2026-12-01 09:30" } });

      const [updated, reminder, cancelled, preempted, bumpCancelled, bumpPending] = mail.sent;

      for (const m of [updated, reminder]) {
        assert.equal(prop(m.ics, "METHOD"), "METHOD:REQUEST");
        assert.equal(prop(m.ics, "SEQUENCE"), "SEQUENCE:1");
      }

      for (const m of [cancelled, preempted, bumpCancelled]) {
        assert.equal(prop(m.ics, "METHOD"), "METHOD:CANCEL");
        assert.equal(prop(m.ics, "SEQUENCE"), "SEQUENCE:2");
        assert.equal(prop(m.ics, "UID"), "UID:meeting-9@meetsched.local");
        assert.match(m.text, /Calendar cancellation attached/);
      }

      assert.equal(bumpPending.ics, "", "a meeting waiting for its organizer gets no calendar change");
    } finally {
      mail.restore();
    }
  });

  it("the attachment's content type names the method", async () => {
    const captured: { contentType?: string }[] = [];
    const nodemailer = await import("nodemailer");
    const { setMailTransport } = await import("@/lib/services/email.service");
    const transport = nodemailer.default.createTransport({ jsonTransport: true });
    const original = transport.sendMail.bind(transport);

    (transport as unknown as { sendMail: unknown }).sendMail = async (m: Parameters<typeof original>[0]) => {
      captured.push(...((m.attachments ?? []) as { contentType?: string }[]));
      return original(m);
    };
    setMailTransport(transport);

    try {
      await send("updated");
      await send("cancelled");
    } finally {
      setMailTransport(null);
    }

    assert.equal(captured[0].contentType, "text/calendar; method=REQUEST; charset=UTF-8");
    assert.equal(captured[1].contentType, "text/calendar; method=CANCEL; charset=UTF-8");
  });
});

describe("recurrence frequencies by name (M-4)", () => {
  it("maps every supported frequency, case-insensitively", () => {
    assert.deepEqual([...RECURRENCE_FREQUENCIES], ["DAILY", "WEEKLY", "MONTHLY"]);

    for (const name of RECURRENCE_FREQUENCIES) {
      assert.equal(frequencyFromName(name), name);
      assert.equal(frequencyFromName(` ${name.toLowerCase()} `), name);
    }
  });

  it("generates the right dates for each", () => {
    assert.deepEqual(computeOccurrenceDates("2026-11-06", "DAILY", 3), ["2026-11-06", "2026-11-09", "2026-11-10"]);
    assert.deepEqual(computeOccurrenceDates("2026-11-02", "WEEKLY", 3), ["2026-11-02", "2026-11-09", "2026-11-16"]);
    assert.deepEqual(computeOccurrenceDates("2027-01-31", "MONTHLY", 3), ["2027-01-31", "2027-02-28", "2027-03-31"]);
  });

  it("rejects unknown frequencies instead of falling back to another one", () => {
    for (const bad of ["YEARLY", "", null, undefined, "1", "weekly-ish"]) {
      assert.equal(frequencyFromName(bad as string), null, String(bad));
    }

    assert.throws(
      () => computeOccurrenceDates("2026-11-02", "YEARLY" as never, 3),
      UnsupportedFrequencyError
    );
    assert.throws(() => computeOccurrenceDates("2026-11-02", 2 as never, 3), UnsupportedFrequencyError);
  });
});

describe("minimum duration (B-01)", () => {
  it("is 15 minutes: 14 is refused, 15 and longer are accepted", () => {
    assert.equal(MIN_MEETING_MINUTES, 15);
    assert.equal(isLongEnough("10:00", "10:14"), false);
    assert.equal(isLongEnough("10:00", "10:15"), true);
    assert.equal(isLongEnough("10:00:00", "11:00:00"), true);
  });

  const single = (end: string) => ({
    title: "Standup",
    meeting_date: dateFromToday(3),
    room_id: 1,
    participant_count: 1,
    meeting_type_id: 1,
    start_time: "10:00",
    end_time: end,
  });

  it("is enforced by the booking and recurring request schemas", () => {
    for (const schema of [createMeetingSchema]) {
      const short = schema.safeParse(single("10:14"));
      assert.equal(short.success, false);
      assert.ok(short.error!.issues.some((i) => /at least 15 minutes/.test(i.message)));
      assert.equal(schema.safeParse(single("10:15")).success, true);
    }

    const series = (end: string) => ({
      title: "Standup",
      room_id: 1,
      meeting_date: dateFromToday(3),
      start_time: "10:00",
      end_time: end,
      participantCount: 1,
      meetingTypeId: 1,
      frequency_id: 2,
      occurrence_count: 2,
    });

    assert.equal(recurringMeetingSchema.safeParse(series("10:14")).success, false);
    assert.equal(recurringMeetingSchema.safeParse(series("10:15")).success, true);
  });
});

describe("booking window and headcount (B-06, B-07)", () => {
  it("ends 3 months ahead on the same day, or the last day of a shorter month", () => {
    assert.equal(bookingWindowEnd("2026-03-15"), "2026-06-15");
    assert.equal(bookingWindowEnd("2026-11-30"), "2027-02-28", "not Mar 2");
    assert.equal(bookingWindowEnd("2027-01-31"), "2027-04-30", "not May 1");
    assert.equal(bookingWindowEnd("2027-11-29"), "2028-02-29", "leap year");
    assert.equal(bookingWindowEnd("2026-10-15"), "2027-01-15", "across the year");
  });

  it("the window check uses it", () => {
    const now = new Date("2026-11-30T06:00:00Z"); // 11:30 on Nov 30 in Asia/Kolkata

    assert.equal(isWithinBookingWindow("2027-02-28", now), true);
    assert.equal(isWithinBookingWindow("2027-03-01", now), false);
    assert.equal(isWithinBookingWindow("2026-11-29", now), false);
  });

  it("caps the participant count on create, recurring and edit", () => {
    const create = createMeetingSchema.safeParse({
      title: "Standup",
      meeting_date: dateFromToday(3),
      room_id: 1,
      participant_count: 3_000_000_000,
      meeting_type_id: 1,
      start_time: "10:00",
      end_time: "11:00",
    });
    assert.equal(create.success, false);

    assert.equal(editMeetingSchema.safeParse({ participantCount: 10_001 }).success, false);
    assert.equal(editMeetingSchema.safeParse({ participantCount: 10_000 }).success, true);
  });
});
