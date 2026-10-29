import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { escapeHtml, sanitizeHeaderValue } from "@/lib/html";
import {
  renderMeetingEmail,
  sendMeetingEmail,
  setMailTransport,
} from "@/lib/services/email.service";
import { captureMail } from "../helpers/fixtures";

const PAYLOADS = [
  `</p><h1 style="color:red">URGENT: re-login</h1><a href="https://evil.example/login">click</a>`,
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `" onmouseover="alert(1)`,
  `'><svg/onload=alert(1)>`,
  `Tom & Jerry <3 "quotes" 'single' \`tick\``,
];

describe("escapeHtml", () => {
  it("escapes every HTML-significant character exactly once", () => {
    assert.equal(
      escapeHtml(`<a href="x" onclick='y'>&</a>\``),
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;&#96;"
    );
  });

  it("does not double-escape when applied once to already-plain text", () => {
    assert.equal(escapeHtml("Q&A"), "Q&amp;A");
    // Input that already contains an entity is data, so it IS escaped (once).
    assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  });

  it("preserves Unicode and normal punctuation", () => {
    const text = "Café ☕ — 会议 · naïve (Q3) 100%!";
    assert.equal(escapeHtml(text), text);
  });

  it("handles null/undefined", () => {
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
  });
});

describe("sanitizeHeaderValue", () => {
  it("removes CR/LF so a title cannot inject headers", () => {
    const out = sanitizeHeaderValue("Hello\r\nBcc: attacker@example.com");
    assert.ok(!/[\r\n]/.test(out));
  });
});

describe("renderMeetingEmail (F-04: HTML injection)", () => {
  for (const payload of PAYLOADS) {
    it(`neutralises ${JSON.stringify(payload.slice(0, 30))}…`, () => {
      const { html, subject, text } = renderMeetingEmail({
        title: payload,
        meetingDate: "2026-12-01",
        startTime: "10:00:00",
        endTime: "11:00:00",
      });

      // No payload-introduced markup survives: the only tags in the body are
      // the template's own.
      const tags = html.match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
      const allowed = ["h2", "p", "strong"];

      for (const tag of tags) {
        const name = /^<\/?([a-zA-Z0-9]+)/.exec(tag)![1].toLowerCase();
        assert.ok(allowed.includes(name), `unexpected tag ${tag}`);
        assert.ok(!/\son\w+=/i.test(tag), `event handler in ${tag}`);
      }

      assert.ok(!html.includes("<script"));
      assert.ok(!html.includes("<img"));
      assert.match(html, /&(lt|gt|amp|quot|#39|#96);/);
      // Plain text alternative keeps the literal title and is not HTML-encoded.
      assert.ok(text.includes(payload));
      assert.ok(!/[\r\n]/.test(subject));
    });
  }

  it("keeps ordinary titles readable", () => {
    const { html } = renderMeetingEmail({
      title: "Q3 planning – Café ☕",
      meetingDate: "2026-12-01",
      startTime: "10:00:00",
      endTime: "11:00:00",
    });

    assert.ok(html.includes("Q3 planning – Café ☕"));
  });

  it("escapes the other dynamic fields too", () => {
    const { html } = renderMeetingEmail({
      title: "t",
      meetingDate: "<b>d</b>",
      startTime: "<i>s</i>",
      endTime: "<u>e</u>",
    });

    assert.ok(!html.includes("<b>d"));
    assert.ok(!html.includes("<i>s"));
    assert.ok(!html.includes("<u>e"));
  });
});

describe("sendMeetingEmail with a mock transport", () => {
  afterEach(() => setMailTransport(null));

  it("sends escaped HTML plus a text alternative and an .ics attachment", async () => {
    const mail = captureMail();

    await sendMeetingEmail(
      ["a@example.test", "b@example.test"],
      PAYLOADS[0],
      "2026-12-01",
      "10:00:00",
      "11:00:00"
    );

    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, "a@example.test,b@example.test");
    assert.ok(!mail.sent[0].html.includes("<h1"));
    assert.ok(!mail.sent[0].html.includes("<a href"));
    assert.ok(mail.sent[0].text.includes("URGENT: re-login"));
  });
});
