import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  entraConfigProblem,
  fetchEntraUsers,
  normalizeDirectoryUsers,
  SyncError,
} from "@/lib/services/entra-sync.service";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

const env = {
  ENTRA_TENANT_ID: "tenant-id",
  ENTRA_CLIENT_ID: "client-id",
  ENTRA_CLIENT_SECRET: "super-secret",
};

describe("directory user normalisation", () => {
  it("keeps good users and lower-cases the id and e-mail", () => {
    const { users, skipped } = normalizeDirectoryUsers([
      { id: ID_A.toUpperCase(), displayName: " Ann Lee ", mail: "Ann.Lee@Example.test", accountEnabled: true },
    ]);

    assert.equal(skipped, 0);
    assert.deepEqual(users, [{ objectId: ID_A, name: "Ann Lee", email: "ann.lee@example.test" }]);
  });

  it("falls back to the sign-in name when there is no mail, and to the e-mail when there is no display name", () => {
    const { users } = normalizeDirectoryUsers([
      { id: ID_A, displayName: "Ann", mail: null, userPrincipalName: "ann@corp.test" },
      { id: ID_B, mail: "bob@corp.test" },
    ]);

    assert.equal(users[0].email, "ann@corp.test");
    assert.equal(users[1].name, "bob");
  });

  it("drops disabled accounts, bad ids, bad e-mails and duplicates (and counts them)", () => {
    const { users, skipped } = normalizeDirectoryUsers([
      { id: ID_A, displayName: "A", mail: "a@x.test" },
      { id: ID_A, displayName: "A again", mail: "other@x.test" }, // same object id
      { id: ID_B, displayName: "B", mail: "a@x.test" }, // same e-mail
      { id: ID_C, displayName: "C", mail: "c@x.test", accountEnabled: false },
      { id: "not-a-uuid", displayName: "D", mail: "d@x.test" },
      { id: ID_C, displayName: "E", mail: "no-at-sign" },
      { displayName: "No id", mail: "n@x.test" },
      { id: ID_C, displayName: "Long", mail: `${"x".repeat(150)}@x.test` },
    ]);

    assert.deepEqual(users.map((u) => u.objectId), [ID_A]);
    assert.equal(skipped, 7);
  });

  it("truncates a long display name to the column size", () => {
    const { users } = normalizeDirectoryUsers([
      { id: ID_A, displayName: "N".repeat(300), mail: "n@x.test" },
    ]);

    assert.equal(users[0].name.length, 100);
  });
});

describe("Entra configuration", () => {
  it("says what is missing, and nothing when complete", () => {
    assert.match(entraConfigProblem({})!, /ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET/);
    assert.match(entraConfigProblem({ ENTRA_TENANT_ID: "t" })!, /ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET/);
    assert.equal(entraConfigProblem(env), null);
  });

  it("refuses to call the directory when it is not configured", async () => {
    await assert.rejects(
      () => fetchEntraUsers({}, (() => assert.fail("must not call out")) as never),
      (error: unknown) => error instanceof SyncError && error.status === 503
    );
  });
});

type Call = { url: string; init?: RequestInit };

function fakeGraph(pages: { value: unknown[]; next?: string }[], tokenOk = true) {
  const calls: Call[] = [];
  let page = 0;

  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });

    if (url.includes("login.microsoftonline.com")) {
      return tokenOk
        ? Response.json({ access_token: "tok" })
        : new Response("tenant details that must not leak", { status: 401 });
    }

    const current = pages[page++];

    return Response.json({ value: current.value, "@odata.nextLink": current.next });
  }) as unknown as typeof fetch;

  return { doFetch, calls };
}

describe("reading the directory", () => {
  it("authenticates with client credentials and follows paging links", async () => {
    const { doFetch, calls } = fakeGraph([
      { value: [{ id: ID_A }], next: "https://graph.microsoft.com/v1.0/users?$skiptoken=abc" },
      { value: [{ id: ID_B }] },
    ]);

    const all = await fetchEntraUsers(env, doFetch);

    assert.deepEqual(all.map((u) => u.id), [ID_A, ID_B]);
    assert.equal(calls.length, 3);

    const token = calls[0];

    assert.ok(token.url.includes("login.microsoftonline.com/tenant-id/oauth2/v2.0/token"));
    assert.match(String(token.init?.body), /grant_type=client_credentials/);
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer tok");
  });

  it("does not follow a paging link that leaves Graph", async () => {
    const { doFetch } = fakeGraph([{ value: [], next: "https://evil.example/steal" }]);

    await assert.rejects(
      () => fetchEntraUsers(env, doFetch),
      (error: unknown) => error instanceof SyncError && /unexpected paging link/.test(error.message)
    );
  });

  it("reports a failed sign-in without echoing the answer or the secret", async () => {
    const { doFetch } = fakeGraph([], false);

    await assert.rejects(
      () => fetchEntraUsers(env, doFetch),
      (error: unknown) =>
        error instanceof SyncError &&
        error.status === 502 &&
        !error.message.includes("tenant details") &&
        !error.message.includes("super-secret")
    );
  });
});
