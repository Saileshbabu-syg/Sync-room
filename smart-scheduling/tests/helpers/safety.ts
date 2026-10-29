// Guard rails for every test that touches a database.
//
// Tests only ever run against a local database whose name starts with
// `ss_test_`. Anything else (the shared Neon database, `smart_db`, a remote
// host, a missing variable) aborts the run — there is deliberately no fallback
// to DATABASE_URL from `.env`.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertSafeTestDatabaseUrl(
  url: string | undefined,
  label = "TEST_DATABASE_URL"
): string {
  if (!url) {
    throw new Error(
      `${label} is not set. Create smart-scheduling/.env.test (see tests/README.md); tests never fall back to DATABASE_URL.`
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }

  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${label} must point at a local database (got host "${parsed.hostname}"). Refusing to run.`
    );
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (!/^ss_test_[a-z0-9_]+$/.test(name)) {
    throw new Error(
      `${label} database "${name}" is not an isolated test database (name must match ss_test_*). Refusing to run.`
    );
  }

  return url;
}

export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@]*@/, "//$1:<redacted>@");
}
