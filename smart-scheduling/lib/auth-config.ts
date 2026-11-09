// How long a sign-in lasts. Auth.js re-signs the session cookie on every
// request, so its own maxAge is only an IDLE limit; `capSessionAge` (the jwt
// callback in auth.ts) adds the absolute limit counted from the sign-in itself.
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

type SessionToken = { authTime?: unknown; iat?: unknown; [key: string]: unknown };

// Stamps the sign-in time on a new token and ends the session (null clears the
// cookie) once it is older than SESSION_MAX_AGE_SECONDS. Tokens issued before
// this existed have no stamp: their current `iat` becomes the start.
export function capSessionAge<T extends SessionToken>(
  token: T,
  isSignIn: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): (T & { authTime: number }) | null {
  const start = isSignIn
    ? nowSeconds
    : typeof token.authTime === "number"
      ? token.authTime
      : typeof token.iat === "number"
        ? token.iat
        : nowSeconds;

  if (nowSeconds - start > SESSION_MAX_AGE_SECONDS) return null;

  return { ...token, authTime: start };
}

// Startup check for the Auth.js / Google OAuth environment, so a production
// deployment with a missing or unsafe setting is reported at boot instead of as
// a confusing sign-in failure. Returns readable messages that name variables,
// never values.
//
// Canonical variables (installed Auth.js v5 beta):
//   AUTH_SECRET   random secret (NEXTAUTH_SECRET is still read as a fallback)
//   AUTH_URL      public origin of the app; pins the callback origin AND is
//                 what turns on trustHost in production (NEXTAUTH_URL is read
//                 for the origin but does not enable trustHost)
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
export function authConfigProblems(
  env: Record<string, string | undefined> = process.env
): string[] {
  const problems: string[] = [];

  const secret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;

  if (!secret) {
    problems.push("AUTH_SECRET is not set.");
  } else if (secret.length < 32) {
    problems.push("AUTH_SECRET is shorter than 32 characters.");
  }

  if (!env.AUTH_URL) {
    problems.push(
      env.NEXTAUTH_URL
        ? "AUTH_URL is not set: NEXTAUTH_URL alone does not enable trustHost, so sign-in fails with UntrustedHost. Rename it to AUTH_URL."
        : "AUTH_URL is not set (the public origin of the app)."
    );
  } else {
    try {
      const url = new URL(env.AUTH_URL);

      if (url.protocol !== "https:") {
        problems.push("AUTH_URL must be an https:// origin in production.");
      }
    } catch {
      problems.push("AUTH_URL is not a valid URL.");
    }
  }

  if (env.AUTH_TRUST_HOST === "true" && !env.AUTH_URL) {
    problems.push(
      "AUTH_TRUST_HOST=true without AUTH_URL trusts whatever Host header arrives; set AUTH_URL instead."
    );
  }

  if (!env.GOOGLE_CLIENT_ID) problems.push("GOOGLE_CLIENT_ID is not set.");
  if (!env.GOOGLE_CLIENT_SECRET) problems.push("GOOGLE_CLIENT_SECRET is not set.");

  return problems;
}
