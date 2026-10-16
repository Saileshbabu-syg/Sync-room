/**
 * Idempotent seed for the meeting-priority feature.
 *
 * Run once after the schema change is applied:
 *   npx tsx db/seed-priority.ts
 *
 * Existing rows are matched by a normalised name (case, spaces and dashes
 * ignored) so "One-on-One" and "one on one" are the same row. Re-running is
 * safe: ranks are updated, missing rows are inserted, nothing is deleted.
 */
import { eq } from "drizzle-orm";

import { db } from "./index";
import {
  meetingStatuses,
  meetingTypes,
  notification_type_master,
  roleMeetingTypes,
  roles,
} from "./schema";

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Lower rank = higher priority. Equal ranks never bump each other.
const MEETING_TYPES = [
  { name: "Client Meeting", rank: 1 },
  { name: "Interview", rank: 2 },
  { name: "Team Meeting", rank: 3 },
  { name: "Training", rank: 4 },
  { name: "One-on-One", rank: 4 },
  // Catch-all for anything that doesn't fit the types above. Lowest priority,
  // bookable by every role.
  { name: "Others", rank: 5 },
] as const;

// Roles are managed directly in the database (no seeding here). Role names are
// matched against the existing `roles` rows; a role that doesn't exist yet is
// skipped with a warning and picked up on the next run.
// Which meeting types each role may book:
const ROLE_TYPES: Record<string, string[]> = {
  Admin: ["One-on-One", "Others"],
  Manager: [
    "Client Meeting",
    "Interview",
    "Team Meeting",
    "Training",
    "One-on-One",
    "Others",
  ],
  "Team Lead": [
    "Client Meeting",
    "Team Meeting",
    "Training",
    "One-on-One",
    "Others",
  ],
  HR: ["Interview", "Training", "One-on-One", "Others"],
  Employee: ["Team Meeting", "One-on-One", "Others"],
};

const STATUSES = ["PENDING_RESCHEDULE", "PENDING_ROOM"];
const NOTIFICATION_TYPES = ["BUMP_REQUEST", "BUMP_RESOLVED"];

async function main() {
  await db.transaction(async (tx) => {
    // Meeting types + priority rank
    const typeIds = new Map<string, number>();
    const existingTypes = await tx.select().from(meetingTypes);
    for (const { name, rank } of MEETING_TYPES) {
      const found = existingTypes.find(
        (t) => normalize(t.meetingTypeName) === normalize(name)
      );
      if (found) {
        await tx
          .update(meetingTypes)
          .set({ priorityRank: rank })
          .where(eq(meetingTypes.meetingTypeId, found.meetingTypeId));
        typeIds.set(name, found.meetingTypeId);
        continue;
      }
      const [created] = await tx
        .insert(meetingTypes)
        .values({ meetingTypeName: name, priorityRank: rank })
        .returning({ id: meetingTypes.meetingTypeId });
      typeIds.set(name, created.id);
    }

    // Role -> allowed meeting types (existing roles only)
    const existingRoles = await tx.select().from(roles);
    for (const [roleName, typeNames] of Object.entries(ROLE_TYPES)) {
      const role = existingRoles.find(
        (r) => normalize(r.roleName) === normalize(roleName)
      );
      if (!role) {
        console.warn(`Role "${roleName}" not found in roles table - skipped.`);
        continue;
      }
      for (const typeName of typeNames) {
        await tx
          .insert(roleMeetingTypes)
          .values({
            roleId: role.roleId,
            meetingTypeId: typeIds.get(typeName)!,
          })
          .onConflictDoNothing();
      }
    }

    // Statuses used while a bump is pending
    for (const name of STATUSES) {
      await tx
        .insert(meetingStatuses)
        .values({ meetingStatusName: name })
        .onConflictDoNothing();
    }

    // Notification types for bump emails / in-app messages
    for (const name of NOTIFICATION_TYPES) {
      await tx
        .insert(notification_type_master)
        .values({ notification_type_name: name })
        .onConflictDoNothing();
    }
  });

  console.log("Priority seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
