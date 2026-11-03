/**
 * Idempotent seed for the default application groups and their permissions.
 *
 *   npx tsx db/seed-groups.ts
 *
 * Migration 0027 already creates these on a real database; this exists for
 * freshly truncated databases (the tests) and for operators. Existing groups
 * (matched by name, case-insensitively) are never changed, so admin edits to
 * priorities or permissions survive a re-run.
 */
import { sql } from "drizzle-orm";

import { ALL_PERMISSIONS, PERMISSION } from "../lib/constants";
import type { DbExecutor } from "../lib/db-types";
import { groupPermissions, groups } from "./schema";

export const DEFAULT_GROUPS = [
  { name: "Leadership", description: "Senior leadership: highest booking priority", priority: 1 },
  { name: "HR", description: "Human resources", priority: 2 },
  { name: "Manager", description: "People managers", priority: 3 },
  { name: "TL", description: "Team leads", priority: 4 },
  { name: "Employee", description: "All other employees", priority: 5 },
  // Admin is a group like the others (the Admin ROLE still guards the admin screens).
  { name: "Admin", description: "Application administrators", priority: 5 },
] as const;

export async function seedGroups(executor: DbExecutor) {
  for (const group of DEFAULT_GROUPS) {
    const [created] = await executor
      .insert(groups)
      .values(group)
      .onConflictDoNothing()
      .returning({ id: groups.id });

    // Only a group created now gets its default permissions.
    if (!created) continue;

    await executor.insert(groupPermissions).values(
      ALL_PERMISSIONS.map((permissionKey) => ({
        groupId: created.id,
        permissionKey,
        // The dashboard is limited to HR and Admin by default; Admin can grant it to others.
        isEnabled:
          permissionKey === PERMISSION.DASHBOARD_VIEW
            ? group.name === "HR" || group.name === "Admin"
            : permissionKey === PERMISSION.GROUP_MANAGE
              ? group.name === "Admin"
              : true,
      }))
    );
  }

  await executor.execute(
    sql`SELECT setval(pg_get_serial_sequence('groups', 'id'), GREATEST((SELECT max(id) FROM groups), 1))`
  );
}

async function main() {
  const { db } = await import("./index");

  await db.transaction((tx) => seedGroups(tx));

  console.log("Group seed complete.");
}

// Run only when executed directly (not when imported by the tests).
if (process.argv[1] && /seed-groups\.[cm]?[jt]s$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}
