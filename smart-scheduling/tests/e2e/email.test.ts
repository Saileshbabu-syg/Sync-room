import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { dateFromToday, seedFixtures, type Fixtures } from "../helpers/fixtures";
import { decodeQuotedPrintable } from "../helpers/smtp-sink";
import { startApp, type App } from "./harness";

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  app = await startApp(3194);
});

after(() => app?.stop());

const waitForMail = async (count: number, ms = 8000) => {
  const deadline = Date.now() + ms;

  while (app.sink.messages.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  return app.sink.messages;
};

// Pull the text/html part out of the raw MIME message and decode it.
function htmlPart(raw: string) {
  const idx = raw.search(/Content-Type: text\/html/i);
  assert.ok(idx >= 0, "message has an HTML part");

  const rest = raw.slice(idx);
  const body = rest.split(/\r?\n\r?\n/).slice(1).join("\n\n").split(/\r?\n--/)[0];
  const encoding = /Content-Transfer-Encoding: (\S+)/i.exec(rest)?.[1].toLowerCase();

  if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);

  return body;
}

const PAYLOAD =
  `</p><h1 style="color:red">URGENT: re-login</h1><a href="https://evil.example/login">verify</a><img src=x onerror=alert(1)>`;

describe("outgoing e-mail through the real SMTP path (F-04, F-10)", () => {
  it("a booking e-mails the attendees, and an HTML-injecting title arrives escaped", async () => {
    const res = await app.call("POST", "/api/meetings/booking", {
      as: f.users.bob,
      body: {
        title: PAYLOAD,
        meeting_date: dateFromToday(6),
        room_id: f.rooms.alpha.room_id,
        participant_count: 2,
        meeting_type_id: f.types.team,
        start_time: "10:00",
        end_time: "11:00",
        participantEmployeeIds: [f.users.carol.employeeId],
      },
    });

    assert.equal(res.status, 201);

    const [message] = await waitForMail(1);

    assert.ok(message, "a mail reached the sink");
    assert.ok(message.to.includes(f.users.bob.email));
    assert.ok(message.to.includes(f.users.carol.email));

    const html = htmlPart(message.data);

    assert.ok(!html.includes("<h1"), html);
    assert.ok(!html.includes("<a href"), html);
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;h1"), "the markup is shown as text");
    assert.ok(message.data.includes("text/plain"), "a plain-text alternative is sent");
    assert.ok(message.data.includes("text/calendar"), "the invite is attached");
  });

  it("the response does not wait for, or depend on, mail delivery", async () => {
    // Point nothing at the sink being slow; simply assert the booking returns
    // without the old 2s mail hop and still succeeds when mail is not read.
    const started = Date.now();
    const res = await app.call("POST", "/api/meetings/booking", {
      as: f.users.carol,
      body: {
        title: "Quick one",
        meeting_date: dateFromToday(7),
        room_id: f.rooms.beta.room_id,
        participant_count: 1,
        meeting_type_id: f.types.others,
        start_time: "09:00",
        end_time: "09:30",
      },
    });

    assert.equal(res.status, 201);
    assert.ok(Date.now() - started < 5000);
  });

  it("an edit sends an 'updated' e-mail; CR/LF in a title is rejected rather than injected into headers", async () => {
    const created = await app.call("POST", "/api/meetings/booking", {
      as: f.users.bob,
      body: {
        title: "Edit me",
        meeting_date: dateFromToday(8),
        room_id: f.rooms.alpha.room_id,
        participant_count: 1,
        meeting_type_id: f.types.others,
        start_time: "13:00",
        end_time: "14:00",
      },
    });
    const id = created.json!.meetingId as number;

    await waitForMail(3);
    const before = app.sink.messages.length;

    const edited = await app.call("PATCH", `/api/meetings/edit/${id}`, {
      as: f.users.bob,
      body: { title: "Edited title" },
    });
    assert.equal(edited.status, 200);

    const messages = await waitForMail(before + 1);
    const last = messages[messages.length - 1];
    assert.match(last.data, /Meeting Updated/);

    const crlf = await app.call("POST", "/api/meetings/booking", {
      as: f.users.bob,
      body: {
        title: "Hello\r\nBcc: attacker@example.com",
        meeting_date: dateFromToday(9),
        room_id: f.rooms.alpha.room_id,
        participant_count: 1,
        meeting_type_id: f.types.others,
        start_time: "13:00",
        end_time: "14:00",
      },
    });
    assert.equal(crlf.status, 400);
    assert.ok(!app.sink.messages.some((m) => /attacker@example\.com/.test(m.data)));
  });
});
