// Runs the Next.js CLI with the isolated test environment, e.g.
//   node tests/helpers/next-with-test-env.mjs build
// (A plain launcher: Next re-spawns workers with the parent's execArgv, which
// breaks when `node --import tsx ...` is used.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(__dirname, "../..");
const envFile = path.join(root, ".env.test");

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Same guard as tests/helpers/safety.ts.
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw new Error("TEST_DATABASE_URL is not set (.env.test)");
const url = new URL(raw);
const dbName = decodeURIComponent(url.pathname.slice(1));
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/^ss_test_[a-z0-9_]+$/.test(dbName)) {
  throw new Error("Refusing to run: TEST_DATABASE_URL is not a local ss_test_* database");
}

process.env.DATABASE_URL = raw;
process.env.DOTENV_CONFIG_PATH = path.join(root, ".env.does-not-exist");
process.env.DOTENV_CONFIG_QUIET = "true";
process.env.EMAIL_USER = "mailer@example.invalid";
process.env.EMAIL_PASSWORD = "not-a-real-password";
process.env.NEXTAUTH_SECRET = "test-only-secret-0123456789abcdef0123456789abcdef";
process.env.AUTH_SECRET = process.env.NEXTAUTH_SECRET;
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.SMTP_HOST ??= "127.0.0.1";
process.env.SMTP_PORT ??= "1";
process.env.REMINDER_CRON_ENABLED = "false";

process.argv.splice(1, 1, path.join(root, "node_modules/next/dist/bin/next"));
await import("next/dist/bin/next");
