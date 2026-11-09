import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatEndTime, formatTimeRange } from "@/lib/format";
import {
  addCalendarDays,
  boundsOverlap,
  durationMinutes,
  isOvernightSlot,
  slotBounds,
  slotEndDate,
  slotTimestamps,
} from "@/lib/time";
import { generateCalendarInvite, generateSeriesCalendarInvite } from "@/lib/services/calendar.service";
import { renderMeetingEmail } from "@/lib/services/email.service";
import {
  checkBookingPolicy,
  NO_LIMITS,
  type BookingPolicy,
} from "@/lib/services/booking-policy.service";
import { createGraphTeamsProvider } from "@/lib/services/teams-meeting.service";

describe("overnight slot arithmetic", () => {
  it("an end earlier than the start ends the next calendar day; equal times are not a slot", () => {
    assert.equal(isOvernightSlot("23:00", "01:00"), true);
    assert.equal(isOvernightSlot("23:30:00", "00:30"), true);
    assert.equal(isOvernightSlot("10:00", "11:00"), false);
    assert.equal(isOvernightSlot("10:00", "10:00"), false);
  });

  it("computes the end date, including month, year and leap-day rollovers", () => {
    assert.equal(slotEndDate("2030-03-10", "23:00", "01:00"), "2030-03-11");
    assert.equal(slotEndDate("2030-03-10", "10:00", "11:00"), "2030-03-10");
    assert.equal(slotEndDate("2030-01-31", "22:00", "02:00"), "2030-02-01");
    assert.equal(slotEndDate("2030-12-31", "22:00", "02:00"), "2031-01-01");
    assert.equal(slotEndDate("2032-02-28", "23:00", "00:30"), "2032-02-29");
    assert.equal(slotEndDate("2031-02-28", "23:00", "00:30"), "2031-03-01");
    assert.equal(addCalendarDays("2030-03-01", -1), "2030-02-28");
  });

  it("measures the examples correctly", () => {
    assert.equal(durationMinutes("23:00", "01:00"), 120);
    assert.equal(durationMinutes("23:30", "00:30"), 60);
    assert.equal(durationMinutes("22:00", "02:00"), 240);
    assert.equal(durationMinutes("10:00:00", "10:45"), 45);
  });

  it("overlap works across midnight in both directions and is half-open", () => {
    const night = slotBounds("2030-03-10", "23:00", "01:00");

    assert.equal(boundsOverlap(night, slotBounds("2030-03-11", "00:00", "00:30")), true);
    assert.equal(boundsOverlap(night, slotBounds("2030-03-11", "00:59", "02:00")), true);
    assert.equal(boundsOverlap(night, slotBounds("2030-03-11", "01:00", "02:00")), false);
    assert.equal(boundsOverlap(night, slotBounds("2030-03-10", "22:00", "23:00")), false);
    assert.equal(boundsOverlap(night, slotBounds("2030-03-10", "22:00", "23:01")), true);
    assert.equal(boundsOverlap(night, slotBounds("2030-03-10", "23:30", "00:30")), true);
    assert.equal(boundsOverlap(night, slotBounds("2030-03-11", "23:00", "01:00")), false);
    // Same clock times, different calendar day: no clash.
    assert.equal(
      boundsOverlap(slotBounds("2030-03-10", "10:00", "11:00"), slotBounds("2030-03-11", "10:00", "11:00")),
      false
    );
  });

  it("produces SQL timestamps for a slot", () => {
    assert.deepEqual(slotTimestamps("2030-03-10", "23:00", "01:00"), {
      start: "2030-03-10 23:00:00",
      end: "2030-03-11 01:00:00",
    });
    assert.deepEqual(slotTimestamps("2030-03-10", "09:00", "10:30:00"), {
      start: "2030-03-10 09:00:00",
      end: "2030-03-10 10:30:00",
    });
  });
});

describe("12-hour display of overnight times (24-hour values stay internal)", () => {
  it("labels an end on the next day", () => {
    assert.equal(formatEndTime("23:00", "01:00"), "01:00 AM (next day)");
    assert.equal(formatEndTime("23:00:00", "01:00:00"), "01:00 AM (next day)");
    assert.equal(formatEndTime("09:00", "10:00"), "10:00 AM");
    assert.equal(formatTimeRange("23:30", "00:30"), "11:30 PM - 12:30 AM (next day)");
    assert.equal(formatTimeRange("14:30", "15:30"), "02:30 PM - 03:30 PM");
    assert.equal(formatTimeRange("22:00:00", "02:00:00"), "10:00 PM - 02:00 AM (next day)");
  });
});

describe("overnight policy in the central booking policy check", () => {
  const open: BookingPolicy = { groupId: 1, canBookRecurring: true, ...NO_LIMITS, allowOvernight: true };
  const booking = (over: Partial<Parameters<typeof checkBookingPolicy>[1]> = {}) => ({
    roomId: 1,
    startTime: "23:00:00",
    endTime: "01:00:00",
    occurrenceDates: ["2031-03-10"],
    isSeries: false,
    ...over,
  });

  it("refuses an overnight meeting unless the effective policy allows it", () => {
    assert.equal(checkBookingPolicy(open, booking(), "2031-03-01"), null);

    const refused = checkBookingPolicy({ ...open, allowOvernight: false }, booking(), "2031-03-01");

    assert.equal(refused?.status, 403);
    assert.match(refused!.message, /Overnight bookings are not permitted/);

    // The same hours on one day need no overnight permission.
    assert.equal(
      checkBookingPolicy({ ...open, allowOvernight: false }, booking({ startTime: "21:00:00", endTime: "23:00:00" }), "2031-03-01"),
      null
    );
  });

  it("applies the maximum duration to the length across midnight, for a series too", () => {
    const capped = { ...open, maxDurationMinutes: 120, maxDurationSource: "group" as const };

    assert.equal(checkBookingPolicy(capped, booking(), "2031-03-01"), null);
    assert.match(
      checkBookingPolicy(capped, booking({ startTime: "22:00:00", endTime: "02:00:00" }), "2031-03-01")!.message,
      /at most 2 hours/
    );
    assert.equal(
      checkBookingPolicy(
        capped,
        booking({ isSeries: true, occurrenceDates: ["2031-03-10", "2031-03-17", "2031-03-24"] }),
        "2031-03-01"
      ),
      null
    );
  });
});

describe("calendar and Teams times for an overnight meeting", () => {
  const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, "");
  const prop = (ics: string, name: string) =>
    unfold(ics)
      .split("\r\n")
      .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

  it("the .ics ends on the next day (23:00-01:00 IST = 17:30Z-19:30Z)", async () => {
    const ics = await generateCalendarInvite("Night shift", "2030-03-10", "23:00", "01:00", undefined, {
      identity: { meetingId: 9, sequence: 0, location: "Alpha" },
    });

    assert.equal(prop(ics, "DTSTART"), "DTSTART:20300310T173000Z");
    assert.equal(prop(ics, "DTEND"), "DTEND:20300310T193000Z");
  });

  it("DTEND is on the next UTC date when the local end is the next morning", async () => {
    const ics = await generateCalendarInvite("Late", "2030-03-10", "22:00", "08:00");

    assert.equal(prop(ics, "DTSTART"), "DTSTART:20300310T163000Z");
    assert.equal(prop(ics, "DTEND"), "DTEND:20300311T023000Z");
  });

  it("a series invite carries one overnight VEVENT per occurrence", async () => {
    const ics = await generateSeriesCalendarInvite("Night series", [
      { date: "2030-03-10", startTime: "23:00", endTime: "01:00", meetingId: 1, sequence: 0 },
      { date: "2030-03-17", startTime: "23:00", endTime: "01:00", meetingId: 2, sequence: 0 },
    ]);
    const ends = unfold(ics)
      .split("\r\n")
      .filter((l) => l.startsWith("DTEND:"));

    assert.deepEqual(ends, ["DTEND:20300310T193000Z", "DTEND:20300317T193000Z"]);
  });

  it("the Teams event ends on the next calendar day in the application's time zone", async () => {
    const bodies: { start: { dateTime: string }; end: { dateTime: string } }[] = [];
    const doFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));

      return new Response(
        JSON.stringify({ id: "E", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" } }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await createGraphTeamsProvider({
      organizerEmail: "rooms@contoso.test",
      tokenProvider: async () => "TOKEN",
      doFetch,
    }).createEvent(
      { title: "Night", meetingDate: "2030-12-31", startTime: "23:00:00", endTime: "01:00:00", roomName: "Alpha" },
      "sched-meeting-1"
    );

    assert.equal(bodies[0].start.dateTime, "2030-12-31T23:00:00");
    assert.equal(bodies[0].end.dateTime, "2031-01-01T01:00:00");
  });
});

describe("e-mail for an overnight meeting", () => {
  it("says the end is the next day, in 12-hour time", () => {
    const { text, html } = renderMeetingEmail({
      title: "Night shift",
      meetingDate: "2030-03-10",
      startTime: "23:00:00",
      endTime: "01:00:00",
    });

    assert.match(text, /Start Time: 11:00 PM/);
    assert.match(text, /End Time: 01:00 AM \(next day\)/);
    assert.match(html, /01:00 AM \(next day\)/);
  });
});
