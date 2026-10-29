import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMeetingSchema } from "@/lib/validations/meeting.validator";
import { recurringMeetingSchema } from "@/lib/validations/recurring-meeting";
import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";
import {
  availableRoomsQuerySchema,
  suggestionsSchema,
} from "@/lib/validations/suggestions.validator";
import { roomBodySchema } from "@/lib/validations/room.validator";
import { isWithinBookingWindow } from "@/lib/validations/date-time";
import { computeOccurrenceDates } from "@/lib/services/recurring-meeting.service";
import { dateFromToday } from "../helpers/fixtures";

const valid = () => ({
  title: "Sprint planning",
  meeting_date: dateFromToday(5),
  room_id: 1,
  participant_count: 2,
  meeting_type_id: 3,
  start_time: "10:00",
  end_time: "11:00",
  participantEmployeeIds: [3],
});

const rejects = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  assert.equal(schema.safeParse(v).success, false);

describe("createMeetingSchema", () => {
  it("accepts a valid booking and ignores legacy client fields (F-21)", () => {
    const parsed = createMeetingSchema.safeParse({
      ...valid(),
      organizer_employee_id: 999,
      meeting_status_id: 3,
    });

    assert.equal(parsed.success, true);
    // The server decides organizer and status; they are not part of the output.
    assert.ok(parsed.success && !("organizer_employee_id" in parsed.data));
    assert.ok(parsed.success && !("meeting_status_id" in parsed.data));
  });

  it("works without the formerly-required fields", () => {
    assert.equal(createMeetingSchema.safeParse(valid()).success, true);
  });

  it("rejects invalid start/end ordering and identical times", () => {
    rejects(createMeetingSchema, { ...valid(), start_time: "11:00", end_time: "10:00" });
    rejects(createMeetingSchema, { ...valid(), start_time: "10:00", end_time: "10:00" });
  });

  it('rejects "HH:MM:SS", malformed times and impossible dates', () => {
    rejects(createMeetingSchema, { ...valid(), start_time: "10:00:00" });
    rejects(createMeetingSchema, { ...valid(), end_time: "25:00" });
    rejects(createMeetingSchema, { ...valid(), meeting_date: "2026-02-30" });
    rejects(createMeetingSchema, { ...valid(), meeting_date: "not-a-date" });
  });

  it("rejects past dates, past times today, and dates beyond the window (F-11)", () => {
    rejects(createMeetingSchema, { ...valid(), meeting_date: dateFromToday(-1) });
    rejects(createMeetingSchema, { ...valid(), meeting_date: dateFromToday(200) });
    rejects(createMeetingSchema, {
      ...valid(),
      meeting_date: dateFromToday(0),
      start_time: "00:00",
      end_time: "00:30",
      // Only fails when "now" in IST is after 00:00, i.e. always except the
      // first minute of the day — the schema compares at minute precision.
    });
  });

  it("rejects NUL / control characters and over-long or empty titles (F-17)", () => {
    rejects(createMeetingSchema, { ...valid(), title: "bad\u0000title" });
    rejects(createMeetingSchema, { ...valid(), title: "bad\ntitle" });
    rejects(createMeetingSchema, { ...valid(), title: "   " });
    rejects(createMeetingSchema, { ...valid(), title: "x".repeat(201) });
  });

  it("rejects wrong types and too many attendees", () => {
    rejects(createMeetingSchema, { ...valid(), room_id: "1" });
    rejects(createMeetingSchema, { ...valid(), participant_count: 0 });
    rejects(createMeetingSchema, { ...valid(), participant_count: 1.5 });
    rejects(createMeetingSchema, {
      ...valid(),
      participantEmployeeIds: Array.from({ length: 101 }, (_, i) => i + 1),
    });
  });
});

describe("recurringMeetingSchema", () => {
  const base = () => ({
    title: "Standup",
    room_id: 1,
    meeting_date: dateFromToday(5),
    start_time: "10:00",
    end_time: "10:30",
    participantCount: 2,
    meetingTypeId: 3,
    frequency_id: 2,
    occurrence_count: 4,
  });

  it("no longer requires organizerEmployeeId / meetingStatusId (F-21)", () => {
    assert.equal(recurringMeetingSchema.safeParse(base()).success, true);
  });

  it("rejects bad counts, ordering and past dates", () => {
    rejects(recurringMeetingSchema, { ...base(), occurrence_count: 0 });
    rejects(recurringMeetingSchema, { ...base(), occurrence_count: 13 });
    rejects(recurringMeetingSchema, { ...base(), start_time: "11:00", end_time: "10:00" });
    rejects(recurringMeetingSchema, { ...base(), meeting_date: dateFromToday(-2) });
  });
});

describe("editMeetingSchema", () => {
  it("accepts partial bodies and rejects control characters", () => {
    assert.equal(editMeetingSchema.safeParse({}).success, true);
    assert.equal(editMeetingSchema.safeParse({ title: "New" }).success, true);
    rejects(editMeetingSchema, { title: "a\u0000b" });
    rejects(editMeetingSchema, { participantCount: -1 });
  });
});

describe("suggestions validation (F-18)", () => {
  const ok = () => ({
    meeting_date: dateFromToday(3),
    start_time: "10:00",
    end_time: "11:00",
    participant_count: 3,
  });

  it("accepts a valid request, with or without room_id", () => {
    assert.equal(suggestionsSchema.safeParse(ok()).success, true);
    assert.equal(suggestionsSchema.safeParse({ ...ok(), room_id: 2 }).success, true);
  });

  it("rejects missing date, non-numeric count, NaN-producing times, short and past slots", () => {
    const { meeting_date: _omit, ...noDate } = ok();
    void _omit;
    rejects(suggestionsSchema, noDate);
    rejects(suggestionsSchema, { ...ok(), participant_count: "abc" });
    rejects(suggestionsSchema, { ...ok(), start_time: "xx", end_time: "yy" });
    rejects(suggestionsSchema, { ...ok(), end_time: "10:10" });
    rejects(suggestionsSchema, { ...ok(), meeting_date: dateFromToday(-1) });
    rejects(suggestionsSchema, { ...ok(), meeting_date: "9999-12-31" });
  });

  it("validates the available-rooms query string the same way (F-02)", () => {
    const q = { date: dateFromToday(2), start: "09:00", end: "10:00", participants: "4" };

    assert.equal(availableRoomsQuerySchema.safeParse(q).success, true);
    rejects(availableRoomsQuerySchema, { ...q, participants: "abc" });
    rejects(availableRoomsQuerySchema, { ...q, date: undefined });
    rejects(availableRoomsQuerySchema, { ...q, end: "08:00" });
  });
});

describe("roomBodySchema (F-16)", () => {
  const ok = () => ({
    roomName: "Delta",
    roomCapacity: 8,
    roomLocation: "Floor 4",
    availabilityStatusId: 1,
  });

  it("accepts a valid room", () => {
    assert.equal(roomBodySchema.safeParse(ok()).success, true);
  });

  it("rejects negative/zero/huge capacity, blank or long names, bad status", () => {
    rejects(roomBodySchema, { ...ok(), roomCapacity: -5 });
    rejects(roomBodySchema, { ...ok(), roomCapacity: 0 });
    rejects(roomBodySchema, { ...ok(), roomCapacity: 1_000_000_000 });
    rejects(roomBodySchema, { ...ok(), roomName: "   " });
    rejects(roomBodySchema, { ...ok(), roomName: "x".repeat(101) });
    rejects(roomBodySchema, { ...ok(), availabilityStatusId: 2 ** 31 });
    rejects(roomBodySchema, { roomCapacity: 5, availabilityStatusId: 1 });
  });
});

describe("booking window and recurrence dates", () => {
  it("window is today .. today + 3 months in the app timezone", () => {
    assert.equal(isWithinBookingWindow(dateFromToday(0)), true);
    assert.equal(isWithinBookingWindow(dateFromToday(-1)), false);
    assert.equal(isWithinBookingWindow(dateFromToday(200)), false);
  });

  it("monthly recurrence clamps to the end of shorter months", () => {
    assert.deepEqual(computeOccurrenceDates("2026-11-30", 3, 4), [
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
      "2027-02-28",
    ]);
  });

  it("daily skips Saturdays and Sundays", () => {
    // Fri 6 Nov -> Mon 9 Nov, not Sat 7 Nov.
    assert.deepEqual(computeOccurrenceDates("2026-11-06", 1, 3), [
      "2026-11-06",
      "2026-11-09",
      "2026-11-10",
    ]);

    // Ten occurrences from a Monday cover exactly two Monday-Friday weeks.
    assert.deepEqual(computeOccurrenceDates("2026-11-02", 1, 10), [
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
    ]);
  });

  it("weekly adds 7 days and daily adds 1 on a working day", () => {
    assert.deepEqual(computeOccurrenceDates("2026-11-02", 2, 3), [
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
    assert.deepEqual(computeOccurrenceDates("2026-11-30", 1, 3), [
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
    ]);
  });
});
