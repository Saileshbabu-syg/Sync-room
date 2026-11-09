import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import {
  meeting,
  notification_type_master,
  notifications,
  room,
} from "@/db/schema";
import { MEETING_STATUS, NOTIFICATION_TYPE, ROLE_ADMIN } from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";
import { safeErrorMessage } from "@/lib/delivery-policy";
import { isMeetingEnded } from "@/lib/time";

import { createAuditLog } from "./audit.service";
import {
  dispatchNotification,
  queueMeetingNotification,
} from "./notification.service";
import {
  getTeamsProvider,
  isValidJoinUrl,
  TEAMS_PROVIDER,
  TeamsError,
  type OnlineMeetingSlot,
} from "./teams-meeting.service";

// Keeps `meeting` rows and their Teams events in step, in the background.
//
// The meeting row is the work item (no separate queue):
//
//   NONE --(booked with Teams)--> PENDING --(worker: created/updated)--> READY
//   READY --(moved / renamed)--> PENDING          (online_version + 1)
//   PENDING --(retryable failure)--> PENDING      (backoff, attempt + 1)
//   PENDING --(permanent failure, or attempts used up)--> FAILED
//   FAILED --(a person retries)--> PENDING        (attempts reset)
//
// Requests never call Microsoft: a booking, move or rename only marks the row
// PENDING inside its own transaction. The per-minute worker
// (processOnlineMeetings) claims due rows one at a time under a lease
// (FOR UPDATE SKIP LOCKED + online_locked_until, attempt counted), calls Graph
// with no transaction open, and records the result fenced by the attempt
// number; a row is only marked READY if online_version is still the one the
// worker worked on, so a newer change is never overwritten (it stays PENDING
// for the next round). Cancelled or replaced meetings are never provisioned;
// their events are removed by the cleanup sweep (cleanupOnlineMeetings), which
// treats an already deleted event as deleted.
//
// Duplicate events: Graph's transactionId (`sched-meeting-<id>`) makes a
// repeated create return the same event (also after a crash between Graph's
// answer and our write). The one remaining window is Graph's own: its
// transactionId de-duplication is time-limited, so a crash followed by a retry
// much later could create a second event; the unique index on
// online_event_id keeps it from ever being attached to two meetings.

export class OnlineMeetingError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OnlineMeetingError";
    this.status = status;
  }
}

export const ONLINE_STATUS = {
  NONE: "NONE",
  PENDING: "PENDING",
  READY: "READY",
  FAILED: "FAILED",
} as const;

// Automatic attempts before a row is FAILED, the lease a worker holds while
// talking to Graph (comfortably above the 15 s request timeout), and the
// backoff between attempts.
export const ONLINE_MAX_ATTEMPTS = 5;
export const ONLINE_LEASE_SECONDS = 120;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

// Wait before the next attempt after `attempt` failed ones: Microsoft's
// Retry-After when it gave one, otherwise 30 s, 1 min, 2 min ... (capped at
// 30 min) with +/-20% jitter so many rows do not retry in lock-step.
export function onlineBackoffMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random
) {
  if (retryAfterMs !== undefined) return Math.max(1000, retryAfterMs);

  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));

  return Math.round(base * (0.8 + 0.4 * random()));
}


// What the booking routes tell the user.
export type OnlineBookingOutcome = {
  requested: boolean;
  // Occurrences whose Teams meeting is being created in the background.
  pending: number;
  created: number;
  failed: number;
  warning?: string;
};

export function pendingOnlineOutcome(count: number): OnlineBookingOutcome {
  return { requested: true, pending: count, created: 0, failed: 0 };
}

const AUDIT_ONLINE = {
  CREATED: "ONLINE_MEETING_CREATED",
  CREATE_FAILED: "ONLINE_MEETING_CREATE_FAILED",
  UPDATED: "ONLINE_MEETING_UPDATED",
  UPDATE_FAILED: "ONLINE_MEETING_UPDATE_FAILED",
  REMOVED: "ONLINE_MEETING_REMOVED",
  RETRY: "ONLINE_MEETING_RETRY",
} as const;

const ACTIVE = [MEETING_STATUS.SCHEDULED, MEETING_STATUS.PENDING_RESCHEDULE];

const clock = (now?: Date): SQL =>
  now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

const later = (now: Date | undefined, ms: number): SQL =>
  sql`${clock(now)} + make_interval(secs => ${ms / 1000})`;

async function auditSafely(
  meetingId: number,
  action: string,
  remarks: string,
  actorEmployeeId?: number | null
) {
  try {
    await createAuditLog(meetingId, action, remarks, actorEmployeeId);
  } catch (error) {
    console.error(
      "Online meeting audit error:",
      error instanceof Error ? error.message : "unknown error"
    );
  }
}

// Inside a booking / move / rename transaction: these meetings' Teams events
// must be (re)synchronised. Only meetings that asked for Teams are touched; a
// new version makes any in-flight work on the old one stale.
export async function requestOnlineSync(executor: DbExecutor, meetingIds: number[]) {
  if (meetingIds.length === 0) return;

  // While a worker holds the lease its attempt number is left alone, so its
  // result is still recorded (fence); seeing the newer version it leaves the
  // row PENDING and the next round synchronises the change.
  const leased = sql`${meeting.online_locked_until} IS NOT NULL AND ${meeting.online_locked_until} > now()`;

  await executor
    .update(meeting)
    .set({
      online_status: ONLINE_STATUS.PENDING,
      online_version: sql`${meeting.online_version} + 1`,
      online_attempts: sql`CASE WHEN ${leased} THEN ${meeting.online_attempts} ELSE 0 END`,
      online_next_attempt_at: sql`now()`,
      online_last_error: null,
    })
    .where(and(inArray(meeting.meeting_id, meetingIds), eq(meeting.online_requested, true)));
}

type Claim = {
  meeting_id: number;
  online_version: number;
  online_attempts: number;
};

// Parks rows whose worker died during their LAST allowed attempt.
async function failAbandoned(now?: Date) {
  await db
    .update(meeting)
    .set({
      online_status: ONLINE_STATUS.FAILED,
      online_locked_until: null,
      online_last_error:
        "The worker stopped during the final attempt; the Teams meeting may not exist.",
    })
    .where(
      and(
        eq(meeting.online_status, ONLINE_STATUS.PENDING),
        lte(meeting.online_locked_until, clock(now)),
        gte(meeting.online_attempts, ONLINE_MAX_ATTEMPTS)
      )
    );
}

// Claims the next due row and COMMITS the claim before Graph is called: one
// statement takes the lease and counts the attempt. Due: PENDING, its backoff
// over, not leased (or the lease expired: its worker died), attempts left,
// and the meeting still happens.
async function claimNext(now?: Date): Promise<Claim | null> {
  const result = await db.execute(sql`
    UPDATE meeting
    SET online_attempts = online_attempts + 1,
        online_locked_until = ${later(now, ONLINE_LEASE_SECONDS * 1000)}
    WHERE meeting_id = (
      SELECT meeting_id FROM meeting
      WHERE online_status = 'PENDING'
        AND (online_next_attempt_at IS NULL OR online_next_attempt_at <= ${clock(now)})
        AND (online_locked_until IS NULL OR online_locked_until <= ${clock(now)})
        AND online_attempts < ${ONLINE_MAX_ATTEMPTS}
        AND meeting_status_id IN (${MEETING_STATUS.SCHEDULED}, ${MEETING_STATUS.PENDING_RESCHEDULE})
      ORDER BY online_next_attempt_at NULLS FIRST, meeting_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING meeting_id, online_version, online_attempts
  `);

  return (result.rows[0] ?? null) as Claim | null;
}

// Our claim still holds: no one re-claimed the row after our lease expired.
const fenced = (claim: Claim) =>
  and(
    eq(meeting.meeting_id, claim.meeting_id),
    eq(meeting.online_attempts, claim.online_attempts),
    isNotNull(meeting.online_locked_until)
  );

async function slotFor(row: typeof meeting.$inferSelect): Promise<OnlineMeetingSlot> {
  const [roomRow] = await db
    .select({ name: room.room_name })
    .from(room)
    .where(eq(room.room_id, row.room_id));

  return {
    title: row.title,
    meetingDate: String(row.meeting_date),
    startTime: String(row.start_time),
    endTime: String(row.end_time),
    roomName: roomRow?.name,
  };
}

// The booking e-mails of this meeting (or of its series, which are anchored on
// the first occurrence) that already went out.
async function bookingEmailsAlreadySent(row: typeof meeting.$inferSelect) {
  const meetingIds =
    row.recurringMeetingId !== null
      ? (
          await db
            .select({ id: meeting.meeting_id })
            .from(meeting)
            .where(eq(meeting.recurringMeetingId, row.recurringMeetingId))
        ).map((m) => m.id)
      : [row.meeting_id];

  const [sent] = await db
    .select({ id: notifications.notification_id })
    .from(notifications)
    .innerJoin(
      notification_type_master,
      eq(notification_type_master.notification_type_id, notifications.notification_type_id)
    )
    .where(
      and(
        inArray(notifications.meeting_id, meetingIds),
        eq(notifications.status, "SENT"),
        inArray(notification_type_master.notification_type_name, [
          NOTIFICATION_TYPE.BOOKED,
          NOTIFICATION_TYPE.INVITED,
        ])
      )
    )
    .limit(1);

  return Boolean(sent);
}

export type OnlineWorkResult = "READY" | "STALE" | "RETRY" | "FAILED" | "SKIPPED";

// One claimed row: create or update its Teams event, then record the result.
async function workOn(claim: Claim, now?: Date): Promise<OnlineWorkResult> {
  const [row] = await db.select().from(meeting).where(eq(meeting.meeting_id, claim.meeting_id));

  if (!row) return "SKIPPED";

  const creating = !row.online_event_id;
  let created: { eventId: string; joinUrl: string } | undefined;

  try {
    const provider = getTeamsProvider();
    const slot = await slotFor(row);

    if (creating) {
      created = await provider.createEvent(slot, `sched-meeting-${row.meeting_id}`);

      if (!created.eventId || !isValidJoinUrl(created.joinUrl)) {
        throw new TeamsError(
          "Microsoft returned no valid Teams joining link.",
          "NO_JOIN_URL",
          502,
          { retryable: false }
        );
      }
    } else {
      await provider.updateEvent(row.online_event_id!, slot);
    }
  } catch (error) {
    return recordFailure(claim, row, error, creating, now);
  }

  // Recorded under the fence. The event is stored even if the meeting was
  // cancelled meanwhile, so the cleanup sweep removes it; READY only for the
  // version this worker synchronised, and only while the meeting happens.
  const stillActive = sql`${meeting.meetingStatusId} IN (${MEETING_STATUS.SCHEDULED}, ${MEETING_STATUS.PENDING_RESCHEDULE})`;
  const sameVersion = sql`${meeting.online_version} = ${claim.online_version}`;

  const [saved] = await db
    .update(meeting)
    .set({
      ...(created
        ? {
            is_online: true,
            online_provider: TEAMS_PROVIDER,
            online_join_url: created.joinUrl,
            online_event_id: created.eventId,
          }
        : {}),
      online_status: sql`CASE WHEN ${stillActive} AND ${sameVersion} THEN 'READY' ELSE ${meeting.online_status} END`,
      online_attempts: sql`CASE WHEN ${sameVersion} THEN 0 ELSE ${meeting.online_attempts} END`,
      online_next_attempt_at: sql`CASE WHEN ${sameVersion} THEN NULL ELSE now() END`,
      online_locked_until: null,
      online_last_error: null,
      online_synced_at: sql`now()`,
      updated_at: new Date(),
    })
    .where(fenced(claim))
    .returning({ status: meeting.online_status });

  if (!saved) return "SKIPPED";

  await auditSafely(
    row.meeting_id,
    created ? AUDIT_ONLINE.CREATED : AUDIT_ONLINE.UPDATED,
    created ? "Microsoft Teams meeting created" : "Microsoft Teams meeting updated"
  );

  if (saved.status !== ONLINE_STATUS.READY) return "STALE";

  // The link arrived after the booking e-mails already went out (they waited
  // as long as allowed, or provisioning was retried later): tell everyone,
  // with a new version of the calendar entry carrying the link.
  if (created && (await bookingEmailsAlreadySent(row))) {
    const notificationId = await db.transaction(async (tx) => {
      await tx
        .update(meeting)
        .set({ ics_sequence: sql`${meeting.ics_sequence} + 1` })
        .where(eq(meeting.meeting_id, row.meeting_id));

      return queueMeetingNotification(tx, row.meeting_id, "UPDATED");
    });

    dispatchNotification(notificationId);
  }

  return "READY";
}

async function recordFailure(
  claim: Claim,
  row: typeof meeting.$inferSelect,
  error: unknown,
  creating: boolean,
  now?: Date
): Promise<OnlineWorkResult> {
  const teams = error instanceof TeamsError ? error : null;

  // The event vanished in Outlook (deleted by hand): start again with a new
  // one rather than fail forever on an id Microsoft no longer knows.
  if (teams?.code === "NOT_FOUND" && !creating) {
    await db
      .update(meeting)
      .set({
        is_online: false,
        online_provider: null,
        online_join_url: null,
        online_event_id: null,
        online_next_attempt_at: sql`now()`,
        online_locked_until: null,
        online_last_error: "The Teams event no longer existed; a new one will be created.",
      })
      .where(fenced(claim));

    return "RETRY";
  }

  // Unexpected (not from Microsoft): logged without details, retried.
  const retryable = teams ? teams.retryable : true;
  const message = teams ? teams.message : safeErrorMessage(error);

  if (!teams) console.error(`Teams provisioning for meeting ${row.meeting_id} failed:`, message);

  const exhausted = !retryable || claim.online_attempts >= ONLINE_MAX_ATTEMPTS;

  await db
    .update(meeting)
    .set({
      online_status: exhausted ? ONLINE_STATUS.FAILED : ONLINE_STATUS.PENDING,
      online_next_attempt_at: exhausted
        ? null
        : later(now, onlineBackoffMs(claim.online_attempts, teams?.retryAfterMs)),
      online_locked_until: null,
      online_last_error: message,
    })
    .where(fenced(claim));

  if (exhausted) {
    await auditSafely(
      row.meeting_id,
      creating ? AUDIT_ONLINE.CREATE_FAILED : AUDIT_ONLINE.UPDATE_FAILED,
      message
    );
  }

  return exhausted ? "FAILED" : "RETRY";
}

// The background worker (one step of the per-minute job). Safe to run on
// several instances at once. Returns what it did.
export async function processOnlineMeetings(
  { now, limit = 20 }: { now?: Date; limit?: number } = {}
) {
  const summary: Record<OnlineWorkResult, number> = {
    READY: 0,
    STALE: 0,
    RETRY: 0,
    FAILED: 0,
    SKIPPED: 0,
  };

  await failAbandoned(now);

  for (let i = 0; i < limit; i++) {
    const claim = await claimNext(now);

    if (!claim) break;

    summary[await workOn(claim, now)]++;
  }

  return summary;
}

let dispatchEnabled = true;

// Test hook: run the worker and the cleanup sweep only when a test says so
// (the per-minute job runs them regardless).
export function setOnlineDispatchEnabled(enabled: boolean) {
  dispatchEnabled = enabled;
}

// Fire-and-forget nudge after a commit that queued Teams work, so it does not
// wait for the next minute. The worker's lease makes this safe to overlap.
export function dispatchOnlineProvisioning() {
  if (!dispatchEnabled) return;

  void processOnlineMeetings({ limit: 5 }).catch((error) => {
    console.error(
      "Teams provisioning error:",
      error instanceof Error ? error.message : "unknown error"
    );
  });
}

// Deletes the Teams event of every meeting that no longer happens (cancelled
// by the organizer, replaced by a higher-priority booking, or expired by the
// legacy bump engine) and clears its online fields once Graph confirmed (an
// already deleted event counts as deleted). A failure is recorded and retried
// with backoff; nothing is deleted twice.
export async function cleanupOnlineMeetings(limit = 50, now?: Date): Promise<number> {
  // Cancelled before any event existed: nothing to remove, nothing pending.
  await db
    .update(meeting)
    .set({ online_status: ONLINE_STATUS.NONE, online_locked_until: null })
    .where(
      and(
        inArray(meeting.meetingStatusId, [MEETING_STATUS.CANCELLED, MEETING_STATUS.PREEMPTED]),
        isNull(meeting.online_event_id),
        inArray(meeting.online_status, [ONLINE_STATUS.PENDING, ONLINE_STATUS.FAILED])
      )
    );

  const rows = await db
    .select({
      id: meeting.meeting_id,
      eventId: meeting.online_event_id,
      attempts: meeting.online_attempts,
    })
    .from(meeting)
    .where(
      and(
        isNotNull(meeting.online_event_id),
        inArray(meeting.meetingStatusId, [MEETING_STATUS.CANCELLED, MEETING_STATUS.PREEMPTED]),
        or(isNull(meeting.online_next_attempt_at), lte(meeting.online_next_attempt_at, clock(now)))
      )
    )
    .orderBy(asc(meeting.meeting_id))
    .limit(limit);

  let removed = 0;

  for (const { id, eventId, attempts } of rows) {
    if (!eventId) continue;

    try {
      await getTeamsProvider().deleteEvent(eventId);
    } catch (error) {
      const teams = error instanceof TeamsError ? error : null;

      // NOT_CONFIGURED is not worth a line per row on every tick.
      if (teams?.code !== "NOT_CONFIGURED") {
        console.error(
          `Teams event cleanup for meeting ${id} failed:`,
          teams ? teams.message : safeErrorMessage(error)
        );
      }

      await db
        .update(meeting)
        .set({
          online_attempts: attempts + 1,
          online_next_attempt_at: later(now, onlineBackoffMs(attempts + 1, teams?.retryAfterMs)),
          online_last_error: teams ? teams.message : safeErrorMessage(error),
        })
        .where(and(eq(meeting.meeting_id, id), eq(meeting.online_event_id, eventId)));

      continue;
    }

    // Only the event id Graph just deleted is cleared.
    const cleared = await db
      .update(meeting)
      .set({
        is_online: false,
        online_provider: null,
        online_join_url: null,
        online_event_id: null,
        online_status: ONLINE_STATUS.NONE,
        online_attempts: 0,
        online_next_attempt_at: null,
        online_locked_until: null,
        online_last_error: null,
        updated_at: new Date(),
      })
      .where(and(eq(meeting.meeting_id, id), eq(meeting.online_event_id, eventId)))
      .returning({ id: meeting.meeting_id });

    if (cleared.length > 0) {
      removed++;

      await auditSafely(id, AUDIT_ONLINE.REMOVED, "Microsoft Teams meeting removed");
    }
  }

  return removed;
}

// Fire-and-forget after a commit that cancelled or replaced meetings.
export function dispatchOnlineCleanup() {
  if (!dispatchEnabled) return;

  void cleanupOnlineMeetings().catch((error) => {
    console.error(
      "Teams event cleanup error:",
      error instanceof Error ? error.message : "unknown error"
    );
  });
}

// Puts FAILED rows back in the worker's queue with fresh attempts (a person
// asked). Only FAILED rows change, so a manual retry never races the worker:
// rows it is working on are PENDING. Returns the meeting ids queued.
async function requeueFailed(meetingIds: number[], actorEmployeeId: number | null) {
  if (meetingIds.length === 0) return [];

  const queued = await db
    .update(meeting)
    .set({
      online_status: ONLINE_STATUS.PENDING,
      online_version: sql`${meeting.online_version} + 1`,
      online_attempts: 0,
      online_next_attempt_at: sql`now()`,
      online_locked_until: null,
    })
    .where(
      and(
        inArray(meeting.meeting_id, meetingIds),
        eq(meeting.online_status, ONLINE_STATUS.FAILED),
        eq(meeting.online_requested, true),
        inArray(meeting.meetingStatusId, ACTIVE)
      )
    )
    .returning({ id: meeting.meeting_id });

  for (const { id } of queued) {
    await auditSafely(id, AUDIT_ONLINE.RETRY, "Teams meeting creation retried", actorEmployeeId);
  }

  if (queued.length > 0) dispatchOnlineProvisioning();

  return queued.map((q) => q.id);
}

// "Retry Teams meeting" on a booking details page: queues this meeting and,
// for a recurring series, every other upcoming occurrence whose Teams meeting
// FAILED. The worker creates them; people are told when each link exists.
export async function retryOnlineMeetings(
  meetingId: number,
  actor: { employeeId: number; role: string }
): Promise<OnlineBookingOutcome> {
  const [row] = await db
    .select()
    .from(meeting)
    .where(eq(meeting.meeting_id, meetingId));

  if (!row) throw new OnlineMeetingError("Meeting not found.", 404);

  if (
    row.organizerEmployeeId !== actor.employeeId &&
    actor.role !== ROLE_ADMIN
  ) {
    throw new OnlineMeetingError(
      "You do not have permission to change this meeting.",
      403
    );
  }

  if (row.meetingStatusId !== MEETING_STATUS.SCHEDULED) {
    throw new OnlineMeetingError(
      "A Teams meeting can only be created for a scheduled meeting.",
      400
    );
  }

  if (isMeetingEnded(row.meeting_date, row.end_time)) {
    throw new OnlineMeetingError("This meeting has already ended.", 400);
  }

  if (!row.online_requested) {
    throw new OnlineMeetingError(
      "Online Teams Meeting was not requested for this booking.",
      400
    );
  }

  if (row.online_status === ONLINE_STATUS.READY) {
    throw new OnlineMeetingError("This meeting already has a Teams meeting.", 409);
  }

  if (row.online_status === ONLINE_STATUS.PENDING) {
    throw new OnlineMeetingError(
      "The Teams meeting is already being created. Please wait a moment.",
      409
    );
  }

  const siblings =
    row.recurringMeetingId !== null
      ? (
          await db
            .select()
            .from(meeting)
            .where(
              and(
                eq(meeting.recurringMeetingId, row.recurringMeetingId),
                eq(meeting.online_status, ONLINE_STATUS.FAILED),
                eq(meeting.meetingStatusId, MEETING_STATUS.SCHEDULED)
              )
            )
        )
          .filter((m) => !isMeetingEnded(m.meeting_date, m.end_time))
          .map((m) => m.meeting_id)
      : [];

  const queued = await requeueFailed(
    [...new Set([meetingId, ...siblings])],
    actor.employeeId
  );

  return pendingOnlineOutcome(queued.length);
}

export type OnlineProvisioningRecord = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  recurringMeetingId: number | null;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
};

// Administrator view: Teams provisioning of meetings that still happen,
// FAILED first (or only `status`), with the safe error and retry timing.
export async function listOnlineProvisioning(
  status?: (typeof ONLINE_STATUS)[keyof typeof ONLINE_STATUS],
  limit = 100
): Promise<{ counts: Record<string, number>; records: OnlineProvisioningRecord[] }> {
  const active = inArray(meeting.meetingStatusId, ACTIVE);

  const counts = await db
    .select({ status: meeting.online_status, n: sql<number>`count(*)::int` })
    .from(meeting)
    .where(and(active, eq(meeting.online_requested, true)))
    .groupBy(meeting.online_status);

  const rows = await db
    .select()
    .from(meeting)
    .where(
      and(
        active,
        eq(meeting.online_requested, true),
        status ? eq(meeting.online_status, status) : eq(meeting.online_status, ONLINE_STATUS.FAILED)
      )
    )
    .orderBy(asc(meeting.meeting_date), asc(meeting.start_time))
    .limit(limit);

  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    records: rows.map((r) => ({
      meetingId: r.meeting_id,
      title: r.title,
      meetingDate: String(r.meeting_date),
      startTime: String(r.start_time),
      recurringMeetingId: r.recurringMeetingId,
      status: r.online_status,
      attempts: r.online_attempts,
      nextAttemptAt: r.online_next_attempt_at?.toISOString() ?? null,
      lastError: r.online_last_error,
      lastSyncedAt: r.online_synced_at?.toISOString() ?? null,
    })),
  };
}

// Administrator retry of one FAILED meeting (Admin role checked by the route).
export async function adminRetryOnlineMeeting(meetingId: number, actorEmployeeId: number) {
  const queued = await requeueFailed([meetingId], actorEmployeeId);

  if (queued.length === 0) {
    throw new OnlineMeetingError(
      "No failed Teams meeting with that id (only FAILED provisioning of a meeting that still happens can be retried).",
      404
    );
  }

  return { queued: queued.length };
}
