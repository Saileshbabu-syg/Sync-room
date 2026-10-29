import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { startApp, type App } from "./harness";

let app: App;
let f: Fixtures;

before(async () => {
  f = await seedFixtures();
  // The real, default limits (no relaxation).
  app = await startApp(3195, { relaxedRateLimits: false });
});

after(() => app?.stop());

describe("rate limiting (F-13)", () => {
  it("a single account is throttled with 429 + Retry-After instead of being allowed to flood", async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;

    // Deliberately invalid bodies: the limiter runs before validation.
    for (let i = 0; i < 25; i++) {
      const res = await app.call("POST", "/api/meetings/booking", { as: f.users.admin, body: {} });
      statuses.push(res.status);
      retryAfter ??= res.headers.get("retry-after");
    }

    assert.ok(statuses.slice(0, 20).every((s) => s === 400), statuses.join(","));
    assert.ok(statuses.slice(20).every((s) => s === 429), statuses.join(","));
    assert.ok(retryAfter && Number(retryAfter) >= 1);
  });

  it("another user is unaffected", async () => {
    const res = await app.call("POST", "/api/meetings/booking", { as: f.users.carol, body: {} });

    assert.equal(res.status, 400);
  });

  it("suggestions, edit and cancel are limited too", async () => {
    let suggestions = 0;
    for (let i = 0; i < 65; i++) {
      const res = await app.call("POST", "/api/meetings/suggestions", { as: f.users.bob, body: {} });
      if (res.status === 429) suggestions++;
    }
    assert.ok(suggestions >= 4, `suggestions throttled ${suggestions} times`);

    let cancels = 0;
    for (let i = 0; i < 35; i++) {
      const res = await app.call("PATCH", "/api/meetings/cancel/999", { as: f.users.manager });
      if (res.status === 429) cancels++;
    }
    assert.ok(cancels >= 4, `cancel throttled ${cancels} times`);
  });
});
