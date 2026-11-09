import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { entraSyncSettings, groupAuditLogs, groups } from "@/db/schema";
import { DEFAULT_GROUP_NAME } from "@/lib/constants";

import { assertMaySetDefaultGroup, GroupError } from "./group.service";

// Admin-editable settings of the Entra ID sync: whether it runs by itself and
// how often, and which group new people start in. A sync can always be started by hand, whatever these say.

export type EntraSettings = {
  autoSyncEnabled: boolean;
  intervalHours: number;
  // Group that people without one are placed in; null only if neither a chosen
  // group nor the built-in Employee group exists.
  defaultGroupId: number | null;
};

export type EntraSettingsInput = {
  autoSyncEnabled: boolean;
  intervalHours: number;
  defaultGroupId: number;
};

// The group new people land in: the one chosen in the settings while it is
// still active, otherwise the built-in Employee group.
export async function resolveDefaultGroupId(): Promise<number | null> {
  const [settings] = await db.select().from(entraSyncSettings);

  const [chosen] = settings?.defaultGroupId
    ? await db
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.id, settings.defaultGroupId), eq(groups.isActive, true)))
    : [];

  if (chosen) return chosen.id;

  const [fallback] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.name, DEFAULT_GROUP_NAME), eq(groups.isActive, true)));

  return fallback?.id ?? null;
}

export async function getEntraSettings(): Promise<EntraSettings> {
  const [settings] = await db.select().from(entraSyncSettings);

  return {
    autoSyncEnabled: settings?.autoSyncEnabled ?? false,
    intervalHours: settings?.intervalHours ?? 24,
    defaultGroupId: await resolveDefaultGroupId(),
  };
}

export async function updateEntraSettings(
  input: EntraSettingsInput,
  actorEmployeeId: number
) {
  const [target] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, input.defaultGroupId), eq(groups.isActive, true)));

  if (!target) throw new GroupError("Choose an active group.", 400);

  await assertMaySetDefaultGroup(actorEmployeeId);

  await db.transaction(async (tx) => {
    await tx
      .insert(entraSyncSettings)
      .values({
        id: 1,
        autoSyncEnabled: input.autoSyncEnabled,
        intervalHours: input.intervalHours,
        defaultGroupId: input.defaultGroupId,
        updatedBy: actorEmployeeId,
      })
      .onConflictDoUpdate({
        target: entraSyncSettings.id,
        set: {
          autoSyncEnabled: input.autoSyncEnabled,
          intervalHours: input.intervalHours,
          defaultGroupId: input.defaultGroupId,
          updatedAt: new Date(),
          updatedBy: actorEmployeeId,
        },
      });

    await tx.insert(groupAuditLogs).values({
      actorEmployeeId,
      action: "ENTRA_SETTINGS_UPDATED",
      details: {
        autoSyncEnabled: input.autoSyncEnabled,
        intervalHours: input.intervalHours,
        defaultGroupId: input.defaultGroupId,
      },
    });
  });
}
