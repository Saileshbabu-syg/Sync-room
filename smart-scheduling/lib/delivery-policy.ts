// Retry policy shared by the two e-mail queues (`notifications` and
// `reminder_logs`). Pure functions, so the policy is testable on its own.

// How long a claimed row stays reserved for the worker that claimed it. A
// worker that dies mid-send leaves the row SENDING; once the lease expires
// another worker may take it over. Comfortably longer than the SMTP timeouts
// (connection 15 s + greeting 15 s + socket 30 s).
export const DELIVERY_LEASE_SECONDS = 5 * 60;

const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_MAX_SECONDS = 60 * 60;

// Wait before the next attempt after `attempt` attempts have failed:
// 1 min, 2 min, 4 min, 8 min ... capped at 1 hour.
export function backoffSeconds(attempt: number) {
  const exponent = Math.max(0, attempt - 1);

  return Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** exponent);
}

export function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

type MailError = {
  code?: unknown;
  responseCode?: unknown;
  message?: unknown;
};

// Whether retrying can help. SMTP 5xx replies are permanent (the relay refused
// the message or every recipient); nodemailer's EENVELOPE means there was no
// valid recipient. Everything else (timeouts, 4xx, connection and
// configuration problems, which an operator can fix) is worth retrying.
export function isPermanentMailError(error: unknown) {
  const e = (error ?? {}) as MailError;

  if (typeof e.responseCode === "number") {
    return e.responseCode >= 500 && e.responseCode < 600;
  }

  return e.code === "EENVELOPE";
}

const EMAIL_ADDRESS = /[^\s<>"'@]+@[^\s<>"'@]+/g;

// A short failure reason that is safe to store and show to an administrator:
// one line, no e-mail addresses (relay replies often quote them), bounded.
export function safeErrorMessage(error: unknown) {
  const e = (error ?? {}) as MailError;
  const parts = [
    typeof e.responseCode === "number" ? `SMTP ${e.responseCode}` : null,
    typeof e.code === "string" ? e.code : null,
    typeof e.message === "string" ? e.message : String(error),
  ].filter(Boolean);

  return parts
    .join(": ")
    .replace(EMAIL_ADDRESS, "<address>")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

// How long the booking, invitation and update e-mails of an online (Teams)
// meeting wait for its joining link before going out without it
// (ONLINE_INVITE_MAX_WAIT_MINUTES, default 15). They go out at once when the
// Teams provisioning FAILED. While they wait they are re-checked every
// ONLINE_HOLD_RECHECK_SECONDS, without using up a delivery attempt.
export const ONLINE_HOLD_RECHECK_SECONDS = 30;

export function onlineInviteMaxWaitMinutes(
  env: Record<string, string | undefined> = process.env
) {
  const raw = env.ONLINE_INVITE_MAX_WAIT_MINUTES;
  const n = Number(raw);

  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : 15;
}
