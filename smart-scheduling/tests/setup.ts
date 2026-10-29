// Preloaded (node --import) before any test file.
//
// Loads smart-scheduling/.env.test, points DATABASE_URL at the isolated test
// database and neutralises the real `.env` (which holds the shared Neon URL and
// real mail credentials) so that nothing in the app can pick it up.

import fs from "node:fs";
import path from "node:path";

import { assertSafeTestDatabaseUrl } from "./helpers/safety";

const root = path.resolve(__dirname, "..");
const envFile = path.join(root, ".env.test");

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);

    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

// Stop `import "dotenv/config"` (db/index.ts, drizzle.config.ts) from reading
// the real .env.
process.env.DOTENV_CONFIG_PATH = path.join(root, ".env.does-not-exist");
process.env.DOTENV_CONFIG_QUIET = "true";

process.env.DATABASE_URL = assertSafeTestDatabaseUrl(
  process.env.TEST_DATABASE_URL
);

// Dummy, obviously-fake credentials: no test can reach a real mail account.
process.env.EMAIL_USER = "mailer@example.invalid";
process.env.EMAIL_PASSWORD = "not-a-real-password";
process.env.NEXTAUTH_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
process.env.AUTH_SECRET = process.env.NEXTAUTH_SECRET;
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

// Any mail the app tries to send without an explicit test transport goes to a
// closed local port (connection refused) instead of Gmail.
process.env.SMTP_HOST ??= "127.0.0.1";
process.env.SMTP_PORT ??= "1";
process.env.REMINDER_CRON_ENABLED = "false";
