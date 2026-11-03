import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MEETING_STATUS, MEETING_STATUS_LABEL } from "@/lib/constants";
import { renderInvitationEmail } from "@/lib/services/email.service";
import { editMeetingSchema } from "@/lib/validations/editMeeting.validator";
import { overlappingParticipant } from "@/lib/validations/participants";
import { recurringMeetingSchema } from "@/lib/validations/recurring-meeting";

describe("mandatory vs optional participants", () => {
  it("detects someone listed in both", () => {
    assert.equal(overlappingParticipant({ participantEmployeeIds: [1, 2], optionalParticipantEmployeeIds: [3] }), false);
    assert.equal(overlappingParticipant({ participantEmployeeIds: [1, 2], optionalParticipantEmployeeIds: [2] }), true);
    assert.equal(overlappingParticipant({ participantEmployeeIds: [1] }), false);
    assert.equal(overlappingParticipant({ optionalParticipantEmployeeIds: [1] }), false);
    assert.equal(overlappingParticipant({}), false);
  });

  it("the edit request rejects an employee in both lists and accepts disjoint lists", () => {
    const both = editMeetingSchema.safeParse({
      participantEmployeeIds: [4, 5],
      optionalParticipantEmployeeIds: [5],
    });

    assert.equal(both.success, false);
    assert.match(both.error!.issues[0].message, /cannot be both/);

    assert.equal(
      editMeetingSchema.safeParse({
        title: "x",
        participantEmployeeIds: [4],
        optionalParticipantEmployeeIds: [5],
      }).success,
      true
    );
  });

  it("the recurring request rejects an employee in both lists", () => {
    const base = {
      title: "Weekly sync",
      room_id: 1,
      meeting_date: "2031-03-05",
      start_time: "10:00",
      end_time: "11:00",
      participantCount: 3,
      meetingTypeId: 1,
      frequency_id: 2,
      occurrence_count: 2,
    };

    const result = recurringMeetingSchema.safeParse({
      ...base,
      participantEmployeeIds: [4],
      optionalParticipantEmployeeIds: [4],
    });

    assert.equal(result.success, false);
    assert.ok(
      result.error!.issues.some((i) => /cannot be both/.test(i.message)),
      "the overlap is reported"
    );
  });
});

describe("invitation e-mail for an optional participant", () => {
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

  it("says the attendance is optional and still has both buttons", () => {
    const mail = renderInvitationEmail({ ...fields, optional: true });

    assert.match(mail.html, /optional participant/);
    assert.match(mail.html, /Your attendance is optional/);
    assert.match(mail.text, /as an optional participant/);
    assert.match(mail.text, /Accept: https:/);
    assert.match(mail.text, /Decline: https:/);
    assert.ok(mail.html.includes(">Accept<") && mail.html.includes(">Decline<"));
  });

  it("does not mention it for a mandatory participant", () => {
    const mail = renderInvitationEmail(fields);

    assert.ok(!/optional/i.test(mail.html));
    assert.ok(!/optional/i.test(mail.text));
  });
});

describe("bumped status", () => {
  it("is shown as Replaced while the stored status stays PREEMPTED (id 6)", () => {
    assert.equal(MEETING_STATUS.PREEMPTED, 6);
    assert.equal(MEETING_STATUS_LABEL[MEETING_STATUS.PREEMPTED], "Replaced");
  });
});

describe("invitation category labels", () => {
  it("name how someone was invited, never Mandatory or Optional", async () => {
    const { invitationCategory, INVITATION_CATEGORY } = await import("@/lib/constants");

    assert.equal(invitationCategory(false), "Primary Invitee");
    assert.equal(invitationCategory(true), "Additional Invitee");

    for (const label of Object.values(INVITATION_CATEGORY)) {
      assert.ok(!/mandatory|optional/i.test(label));
    }
  });

  it("no status or page label shows the word Bumped", () => {
    for (const label of Object.values(MEETING_STATUS_LABEL)) {
      assert.ok(!/bump/i.test(label), label);
    }
  });
});
