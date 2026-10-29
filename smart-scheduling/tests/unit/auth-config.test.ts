import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authConfigProblems } from "@/lib/auth-config";

const good = {
  AUTH_SECRET: "x".repeat(32),
  AUTH_URL: "https://rooms.example.com",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
};

describe("authConfigProblems", () => {
  it("is empty for a valid production configuration", () => {
    assert.deepEqual(authConfigProblems(good), []);
  });

  it("accepts NEXTAUTH_SECRET as the secret", () => {
    const { AUTH_SECRET, ...rest } = good;

    assert.deepEqual(
      authConfigProblems({ ...rest, NEXTAUTH_SECRET: AUTH_SECRET }),
      []
    );
  });

  it("flags NEXTAUTH_URL used without AUTH_URL", () => {
    const { AUTH_URL, ...rest } = good;
    const problems = authConfigProblems({ ...rest, NEXTAUTH_URL: AUTH_URL });

    assert.equal(problems.length, 1);
    assert.match(problems[0], /UntrustedHost/);
  });

  it("flags a missing/short secret, http origin, bad URL and missing Google credentials", () => {
    assert.ok(authConfigProblems({ ...good, AUTH_SECRET: undefined }).length);
    assert.ok(authConfigProblems({ ...good, AUTH_SECRET: "short" }).length);
    assert.ok(authConfigProblems({ ...good, AUTH_URL: "http://rooms.example.com" }).length);
    assert.ok(authConfigProblems({ ...good, AUTH_URL: "nope" }).length);
    assert.equal(
      authConfigProblems({ ...good, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }).length,
      2
    );
  });

  it("flags AUTH_TRUST_HOST without AUTH_URL and never echoes values", () => {
    const problems = authConfigProblems({
      AUTH_SECRET: "super-secret-value-that-is-long-enough-123",
      AUTH_TRUST_HOST: "true",
    });

    assert.ok(problems.some((p) => /AUTH_TRUST_HOST/.test(p)));
    assert.ok(!problems.join(" ").includes("super-secret-value"));
  });
});
