import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  entraGroupMappings,
  entraSyncSettings,
  groupAuditLogs,
  groups,
} from "@/db/schema";
import { GroupError } from "./group.service";

// Admin-editable settings of the Entra ID sync: whether it runs by itself and
// how often, and which Entra security group puts a first-time person into which
// app group. Mappings never move anyone who already has a group.

export type EntraSettings = {
  autoSyncEnabled: boolean;
  intervalHours: number;
  mappings: {
    entraGroupId: string;
    entraGroupName: string;
    groupId: number;
    groupName: string;
  }[];
};

export type EntraSettingsInput = {
  autoSyncEnabled: boolean;
  intervalHours: number;
  mappings: { entraGroupId: string; entraGroupName: string; groupId: number }[];
};

export async function getEntraSettings(): Promise<EntraSettings> {
  const [settings] = await db.select().from(entraSyncSettings);

  const mappings = await db
    .select({
      entraGroupId: entraGroupMappings.entraGroupId,
      entraGroupName: entraGroupMappings.entraGroupName,
      groupId: entraGroupMappings.groupId,
      groupName: groups.name,
    })
    .from(entraGroupMappings)
    .innerJoin(groups, eq(groups.id, entraGroupMappings.groupId))
    .orderBy(asc(entraGroupMappings.entraGroupName), asc(entraGroupMappings.id));

  return {
    autoSyncEnabled: settings?.autoSyncEnabled ?? false,
    intervalHours: settings?.intervalHours ?? 24,
    mappings: mappings.map((m) => ({ ...m, entraGroupName: m.entraGroupName ?? "" })),
  };
}

export async function updateEntraSettings(
  input: EntraSettingsInput,
  actorEmployeeId: number
) {
  await db.transaction(async (tx) => {
    const wanted = [...new Set(input.mappings.map((m) => m.groupId))];

    if (wanted.length > 0) {
      const known = new Set((await tx.select({ id: groups.id }).from(groups)).map((g) => g.id));

      if (!wanted.every((id) => known.has(id))) {
        throw new GroupError("One or more groups do not exist.", 400);
      }
    }

    await tx
      .insert(entraSyncSettings)
      .values({
        id: 1,
        autoSyncEnabled: input.autoSyncEnabled,
        intervalHours: input.intervalHours,
        updatedBy: actorEmployeeId,
      })
      .onConflictDoUpdate({
        target: entraSyncSettings.id,
        set: {
          autoSyncEnabled: input.autoSyncEnabled,
          intervalHours: input.intervalHours,
          updatedAt: new Date(),
          updatedBy: actorEmployeeId,
        },
      });

    await tx.delete(entraGroupMappings);

    if (input.mappings.length > 0) {
      await tx.insert(entraGroupMappings).values(
        input.mappings.map((m) => ({
          entraGroupId: m.entraGroupId,
          entraGroupName: m.entraGroupName || null,
          groupId: m.groupId,
        }))
      );
    }

    await tx.insert(groupAuditLogs).values({
      actorEmployeeId,
      action: "ENTRA_SETTINGS_UPDATED",
      details: {
        autoSyncEnabled: input.autoSyncEnabled,
        intervalHours: input.intervalHours,
        mappings: input.mappings.map((m) => ({
          entraGroupId: m.entraGroupId,
          groupId: m.groupId,
        })),
      },
    });
  });
}
