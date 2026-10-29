/**
 * Idempotent seed for the lookup tables the application hard-wires by id.
 *
 *   npx tsx db/seed-lookups.ts
 *
 * A brand-new database (see migration 0000) is empty; the app relies on
 * meeting_statuses 1/2/3, availability_master 1, the three recurrence
 * frequencies and the roles below. Existing rows are never changed — if a
 * required id holds a different value the script stops and says so instead of
 * silently reshuffling data. Re-running is safe.
 *
 * Also exported (`seedLookups`) for the automated tests.
 * Afterwards run `npx tsx db/seed-priority.ts` for meeting types and the
 * role -> meeting-type matrix.
 */
import { eq, sql } from "drizzle-orm";

import type { DbExecutor } from "../lib/db-types";
import {
  availabilityMaster,
  meetingStatuses,
  recurrence_frequency_master,
  roles,
} from "./schema";
import { AVAILABILITY_STATUS, MEETING_STATUS } from "../lib/constants";

export const MEETING_STATUS_ROWS = [
  { id: MEETING_STATUS.SCHEDULED, name: "Scheduled" },
  { id: MEETING_STATUS.COMPLETED, name: "Completed" },
  { id: MEETING_STATUS.CANCELLED, name: "Cancelled" },
] as const;

export const AVAILABILITY_ROWS = [
  { id: AVAILABILITY_STATUS.AVAILABLE, code: "Available" },
  { id: 2, code: "Maintenance" },
] as const;

export const FREQUENCY_ROWS = [
  { id: 1, name: "DAILY" },
  { id: 2, name: "WEEKLY" },
  { id: 3, name: "MONTHLY" },
] as const;

export const ROLE_NAMES = [
  "Admin",
  "Manager",
  "Team Lead",
  "HR",
  "Employee",
] as const;

export async function seedLookups(executor: DbExecutor) {
  for (const { id, name } of MEETING_STATUS_ROWS) {
    await executor
      .insert(meetingStatuses)
      .values({ meetingStatusId: id, meetingStatusName: name })
      .onConflictDoNothing();
  }

  for (const { id, code } of AVAILABILITY_ROWS) {
    await executor
      .insert(availabilityMaster)
      .values({
        availabilityStatusId: id,
        availabilityStatusCode: code,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }

  for (const { id, name } of FREQUENCY_ROWS) {
    await executor
      .insert(recurrence_frequency_master)
      .values({ frequency_id: id, frequency_name: name })
      .onConflictDoNothing();
  }

  for (const roleName of ROLE_NAMES) {
    await executor.insert(roles).values({ roleName }).onConflictDoNothing();
  }

  // Explicit ids bypass the serial sequences; move them past the seeded rows.
  for (const [table, column] of [
    ["meeting_statuses", "meeting_status_id"],
    ["availability_master", "availability_status_id"],
    ["recurrence_frequency_master", "frequency_id"],
  ] as const) {
    await executor.execute(
      sql.raw(
        `SELECT setval(pg_get_serial_sequence('${table}', '${column}'), GREATEST((SELECT max(${column}) FROM ${table}), 1))`
      )
    );
  }

  await assertLookupIds(executor);
}

// The code names these ids (lib/constants.ts); fail loudly if the table says
// something else.
export async function assertLookupIds(executor: DbExecutor) {
  for (const { id, name } of MEETING_STATUS_ROWS) {
    const [row] = await executor
      .select()
      .from(meetingStatuses)
      .where(eq(meetingStatuses.meetingStatusId, id));

    if (row?.meetingStatusName?.toLowerCase() !== name.toLowerCase()) {
      throw new Error(
        `meeting_statuses id ${id} must be "${name}" but is "${row?.meetingStatusName ?? "missing"}"`
      );
    }
  }

  const [available] = await executor
    .select()
    .from(availabilityMaster)
    .where(
      eq(
        availabilityMaster.availabilityStatusId,
        AVAILABILITY_STATUS.AVAILABLE
      )
    );

  if (available?.availabilityStatusCode?.toLowerCase() !== "available") {
    throw new Error(
      `availability_master id ${AVAILABILITY_STATUS.AVAILABLE} must be "Available" but is "${available?.availabilityStatusCode ?? "missing"}"`
    );
  }
}

async function main() {
  const { db } = await import("./index");

  await db.transaction((tx) => seedLookups(tx));

  console.log("Lookup seed complete.");
}

// Run only when executed directly (not when imported by the tests).
if (process.argv[1] && /seed-lookups\.[cm]?[jt]s$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}
