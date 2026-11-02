import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  roomRequestDecisionSchema,
  roomRequestExtrasSchema,
} from "@/lib/validations/room-request.validator";

describe("room request message", () => {
  it("is trimmed and kept as the requester wrote it", () => {
    const parsed = roomRequestExtrasSchema.parse({
      message: "  Client meeting, please release.\nThanks  ",
    });

    assert.equal(parsed.message, "Client meeting, please release.\nThanks");
  });

  it("is mandatory: empty and whitespace-only are rejected", () => {
    for (const message of ["", "   ", "\n\t "]) {
      assert.equal(roomRequestExtrasSchema.safeParse({ message }).success, false);
    }

    assert.equal(roomRequestExtrasSchema.safeParse({}).success, false);
  });

  it("has a length limit of 1000 characters", () => {
    assert.equal(
      roomRequestExtrasSchema.safeParse({ message: "a".repeat(1000) }).success,
      true
    );
    assert.equal(
      roomRequestExtrasSchema.safeParse({ message: "a".repeat(1001) }).success,
      false
    );
  });

  it("rejects control characters", () => {
    assert.equal(
      roomRequestExtrasSchema.safeParse({ message: "hi\u0000there" }).success,
      false
    );
  });

  it("only accepts a plain request key", () => {
    assert.equal(
      roomRequestExtrasSchema.safeParse({
        message: "x",
        client_request_id: "3f2b8c1e-aaaa-bbbb-cccc-1234567890ab",
      }).success,
      true
    );
    assert.equal(
      roomRequestExtrasSchema.safeParse({
        message: "x",
        client_request_id: "../../etc",
      }).success,
      false
    );
  });
});

describe("room request decisions", () => {
  it("accepts the four actions", () => {
    for (const body of [
      { action: "approve" },
      { action: "approve", release_booking: true },
      { action: "reject", reason: "Client visit" },
      { action: "release" },
      { action: "cancel" },
    ]) {
      assert.equal(roomRequestDecisionSchema.safeParse(body).success, true, JSON.stringify(body));
    }
  });

  it("refuses anything else, so a client cannot set the status itself", () => {
    for (const body of [
      { action: "APPROVED" },
      { status: "APPROVED" },
      { action: "approve", release_booking: "yes" },
      { action: "reject", reason: "x".repeat(501) },
      {},
    ]) {
      assert.equal(roomRequestDecisionSchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });

  it("drops fields the client has no business sending", () => {
    const parsed = roomRequestDecisionSchema.parse({
      action: "approve",
      organizer_id: 1,
      requester_id: 2,
    });

    assert.deepEqual(parsed, { action: "approve" });
  });
});
