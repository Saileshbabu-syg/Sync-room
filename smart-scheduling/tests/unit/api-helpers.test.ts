import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dbErrorCode,
  guardMutation,
  parseIdParam,
} from "@/lib/api";
import { checkRateLimit, resetRateLimits } from "@/lib/rate-limit";

const req = (headers: Record<string, string>) =>
  new Request("http://localhost:3000/api/x", { method: "POST", headers });

describe("parseIdParam (F-17)", () => {
  it("accepts plain positive integers", () => {
    assert.equal(parseIdParam("1"), 1);
    assert.equal(parseIdParam("2147483647"), 2147483647);
  });

  it("rejects everything the audit used to turn into a 500", () => {
    for (const bad of ["1.5", "abc", "-1", "0", "99999999999", "", "1e3", " 1", "1 ", "0x10", "٣"]) {
      assert.equal(parseIdParam(bad), null, JSON.stringify(bad));
    }

    assert.equal(parseIdParam(undefined), null);
  });
});

describe("guardMutation (F-22: CSRF defence in depth)", () => {
  it("allows same-origin JSON", () => {
    const r = req({
      "content-type": "application/json",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
    });

    assert.equal(guardMutation(r), null);
  });

  it("allows non-browser clients (no Origin / Sec-Fetch-Site)", () => {
    assert.equal(guardMutation(req({ "content-type": "application/json; charset=utf-8" })), null);
  });

  it("rejects text/plain and form posts with 415", () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      const res = guardMutation(req({ "content-type": type }));
      assert.equal(res?.status, 415, type);
    }
  });

  it("rejects cross-site requests with 403", () => {
    assert.equal(
      guardMutation(req({ "content-type": "application/json", "sec-fetch-site": "cross-site" }))?.status,
      403
    );
    assert.equal(
      guardMutation(
        req({ "content-type": "application/json", host: "localhost:3000", origin: "https://evil.example" })
      )?.status,
      403
    );
    assert.equal(
      guardMutation(req({ "content-type": "application/json", origin: "not a url" }))?.status,
      403
    );
  });

  it("can skip the JSON requirement for body-less mutations", () => {
    assert.equal(guardMutation(req({}), { expectJson: false }), null);
    assert.equal(
      guardMutation(req({ "sec-fetch-site": "cross-site" }), { expectJson: false })?.status,
      403
    );
  });
});

describe("dbErrorCode", () => {
  it("finds the SQLSTATE through wrapped driver errors", () => {
    const pg = Object.assign(new Error("conflicting key value"), { code: "23P01" });
    const wrapped = Object.assign(new Error("Failed query"), { cause: pg });

    assert.equal(dbErrorCode(wrapped), "23P01");
    assert.equal(dbErrorCode(new Error("plain")), undefined);
    assert.equal(dbErrorCode(null), undefined);
  });
});

describe("checkRateLimit (F-13)", () => {
  it("allows up to the limit, then blocks until the window resets", () => {
    resetRateLimits();

    for (let i = 0; i < 3; i++) {
      assert.equal(checkRateLimit("k", 3, 1000, 10_000).allowed, true);
    }

    const blocked = checkRateLimit("k", 3, 1000, 10_500);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1);

    assert.equal(checkRateLimit("k", 3, 1000, 11_001).allowed, true);
  });

  it("limits each key independently", () => {
    resetRateLimits();

    assert.equal(checkRateLimit("a", 1, 1000, 0).allowed, true);
    assert.equal(checkRateLimit("a", 1, 1000, 1).allowed, false);
    assert.equal(checkRateLimit("b", 1, 1000, 1).allowed, true);
  });
});
