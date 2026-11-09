import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  invitationLink,
  invitationToken,
  isValidInvitationToken,
} from "@/lib/invitation-token";
import { renderInvitationEmail } from "@/lib/services/email.service";

describe("invitation tokens", () => {
  it("are 64 hex characters and stable for one meeting and employee", () => {
    const t = invitationToken(10, 3);

    assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(invitationToken(10, 3), t, "the same link can be re-sent");
  });

  it("only validate for the meeting and employee they were issued for", () => {
    const t = invitationToken(10, 3);

    assert.equal(isValidInvitationToken(10, 3, t), true);
    assert.equal(isValidInvitationToken(11, 3, t), false, "another meeting");
    assert.equal(isValidInvitationToken(10, 4, t), false, "another person");
  });

  it("reject tampered, truncated and non-hex tokens without throwing", () => {
    const t = invitationToken(10, 3);
    const flipped = (t[0] === "a" ? "b" : "a") + t.slice(1);

    assert.equal(isValidInvitationToken(10, 3, flipped), false);
    assert.equal(isValidInvitationToken(10, 3, t.slice(0, 63)), false);
    assert.equal(isValidInvitationToken(10, 3, `${t}0`), false);
    assert.equal(isValidInvitationToken(10, 3, "z".repeat(64)), false);
    assert.equal(isValidInvitationToken(10, 3, ""), false);
    assert.equal(isValidInvitationToken(10, 3, t.toUpperCase()), false);
  });

  it("links point to the confirmation page and carry a valid token", () => {
    for (const action of ["accept", "decline"] as const) {
      const url = new URL(invitationLink(10, 3, action));

      assert.equal(url.pathname, "/invite");
      assert.equal(url.searchParams.get("a"), action);
      assert.equal(url.searchParams.get("m"), "10");
      assert.equal(url.searchParams.get("e"), "3");
      assert.ok(isValidInvitationToken(10, 3, url.searchParams.get("t")!));
    }
  });
});

describe("invitation e-mail", () => {
  const fields = {
    title: "Budget review",
    organizerName: "Bob Employee",
    roomName: "Alpha",
    meetingDate: "2031-03-05",
    startTime: "10:00:00",
    endTime: "11:00:00",
    acceptUrl: "https://app.example.test/invite?m=1&e=2&t=abc&a=accept",
    declineUrl: "https://app.example.test/invite?m=1&e=2&t=abc&a=decline",
  };

  it("carries the meeting details and both buttons", () => {
    const { subject, html, text } = renderInvitationEmail(fields);

    assert.equal(subject, "Meeting Invitation - Budget review");

    for (const value of ["Budget review", "Bob Employee", "Alpha", "2031-03-05", "10:00 AM", "11:00 AM"]) {
      assert.ok(html.includes(value), `html: ${value}`);
      assert.ok(text.includes(value), `text: ${value}`);
    }

    assert.ok(html.includes(">Accept</a>") && html.includes(">Decline</a>"));
    assert.ok(html.includes("t=abc&amp;a=accept"), "href is attribute-escaped");
    assert.ok(text.includes(`Accept: ${fields.acceptUrl}`));
    assert.ok(text.includes(`Decline: ${fields.declineUrl}`));
  });

  it("escapes markup in titles and names, and strips line breaks from the subject", () => {
    const { subject, html } = renderInvitationEmail({
      ...fields,
      title: '<img src=x onerror=alert(1)>\r\nBcc: evil@example.test',
      organizerName: "<b>Mallory</b>",
    });

    assert.ok(!html.includes("<img"));
    assert.ok(!html.includes("<b>Mallory"));
    assert.ok(html.includes("&lt;img"));
    assert.ok(!/[\r\n]/.test(subject));
  });

  it("mentions that a series answer covers every occurrence", () => {
    const { text } = renderInvitationEmail({
      ...fields,
      seriesNote: "This is part of a recurring series. Your answer applies to every occurrence.",
    });

    assert.match(text, /recurring series/);
  });
});
