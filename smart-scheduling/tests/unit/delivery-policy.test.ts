import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backoffSeconds,
  DELIVERY_LEASE_SECONDS,
  isPermanentMailError,
  safeErrorMessage,
} from "@/lib/delivery-policy";
import {
  addressing,
  renderInvitationEmail,
  renderMeetingEmail,
  timeZoneLabel,
} from "@/lib/services/email.service";

// Phase 2: N8 (retry policy), N5 (addressing), N7 (time zone in e-mails).

describe("retry policy (N8)", () => {
  it("backs off exponentially, capped at one hour", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 20].map(backoffSeconds),
      [60, 120, 240, 480, 960, 1920, 3600, 3600]
    );
  });

  it("leases outlast the SMTP timeouts", () => {
    assert.ok(DELIVERY_LEASE_SECONDS >= 120);
  });

  it("treats SMTP 5xx and no-valid-recipient as permanent, everything else as retryable", () => {
    assert.equal(isPermanentMailError({ responseCode: 550 }), true);
    assert.equal(isPermanentMailError({ responseCode: 554 }), true);
    assert.equal(isPermanentMailError({ code: "EENVELOPE" }), true);

    assert.equal(isPermanentMailError({ responseCode: 421 }), false);
    assert.equal(isPermanentMailError({ responseCode: 451, code: "EENVELOPE" }), false);
    assert.equal(isPermanentMailError({ code: "ETIMEDOUT" }), false);
    assert.equal(isPermanentMailError({ code: "EAUTH" }), false);
    assert.equal(isPermanentMailError(new Error("connection reset")), false);
    assert.equal(isPermanentMailError(undefined), false);
  });

  it("stores a short, single-line reason without e-mail addresses", () => {
    const reason = safeErrorMessage(
      Object.assign(new Error("550 5.1.1 <carol.emp@example.test>:\r\nRecipient unknown"), {
        responseCode: 550,
        code: "EENVELOPE",
      })
    );

    assert.equal(reason, "SMTP 550: EENVELOPE: 550 5.1.1 <<address>>: Recipient unknown");
    assert.ok(safeErrorMessage(new Error("x".repeat(5000))).length <= 500);
  });
});

describe("recipient privacy (N5)", () => {
  it("one recipient goes in To, several only in Bcc", () => {
    assert.deepEqual(addressing("a@example.test"), { to: "a@example.test" });
    assert.deepEqual(addressing(["a@example.test"]), { to: "a@example.test" });
    assert.deepEqual(addressing(["a@example.test", "b@example.test"]), {
      bcc: ["a@example.test", "b@example.test"],
    });
  });
});

describe("time zone in e-mails (N7)", () => {
  it("labels the application zone with its UTC offset", () => {
    assert.equal(timeZoneLabel("2026-12-01", "10:00:00"), "Asia/Kolkata (UTC+05:30)");
  });

  it("uses the offset in force on each date for zones with daylight saving", () => {
    assert.equal(timeZoneLabel("2026-01-15", "10:00", "Europe/London"), "Europe/London (UTC+00:00)");
    assert.equal(timeZoneLabel("2026-07-15", "10:00", "Europe/London"), "Europe/London (UTC+01:00)");
    assert.equal(timeZoneLabel("2026-07-15", "10:00", "America/New_York"), "America/New_York (UTC-04:00)");
  });

  it("falls back to the bare zone name for unparseable values", () => {
    assert.equal(timeZoneLabel("<b>d</b>", "10:00"), "Asia/Kolkata");
  });

  it("single-meeting e-mails state the time zone", () => {
    for (const kind of ["scheduled", "updated", "reminder", "cancelled"] as const) {
      const m = renderMeetingEmail({
        title: "Standup",
        meetingDate: "2026-12-01",
        startTime: "10:00:00",
        endTime: "11:00:00",
        kind,
      });

      assert.ok(m.text.includes("Time zone: Asia/Kolkata (UTC+05:30)"), kind);
      assert.ok(m.html.includes("<strong>Time zone:</strong> Asia/Kolkata (UTC+05:30)"), kind);
    }
  });

  it("recurring e-mails state it once (no daylight saving in the app zone)", () => {
    const m = renderMeetingEmail({
      title: "Standup",
      meetingDate: "2026-12-02",
      startTime: "10:00:00",
      endTime: "10:30:00",
      series: {
        frequency: "Weekly",
        startDate: "2026-12-02",
        endDate: "2026-12-16",
        occurrences: [
          { date: "2026-12-02", startTime: "10:00:00", endTime: "10:30:00" },
          { date: "2026-12-09", startTime: "10:00:00", endTime: "10:30:00" },
          { date: "2026-12-16", startTime: "10:00:00", endTime: "10:30:00" },
        ],
        skippedDates: [],
        cancelledDates: [],
      } as never,
    });

    assert.ok(m.text.includes("Time zone: Asia/Kolkata (UTC+05:30)"));
    assert.ok(m.text.includes("1. 2026-12-02 (Wed), 10:00 AM - 10:30 AM\n"), "no per-line offset needed");
  });

  it("invitations state it too", () => {
    const m = renderInvitationEmail({
      title: "Standup",
      organizerName: "Bob",
      roomName: "Alpha",
      meetingDate: "2026-12-01",
      startTime: "10:00:00",
      endTime: "11:00:00",
      acceptUrl: "https://app.example.test/a",
      declineUrl: "https://app.example.test/d",
    });

    assert.ok(m.text.includes("Time zone: Asia/Kolkata (UTC+05:30)"));
  });
});
