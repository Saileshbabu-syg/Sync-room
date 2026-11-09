import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  appBookingSettings,
  employee,
  groupAuditLogs,
  groupSettings,
  groups,
  roles,
} from "@/db/schema";
import type { AppBookingPolicy } from "@/lib/booking-limits";
import type { AppBookingSettingsInput } from "@/lib/validations/booking-settings.validator";

import { getAppBookingPolicy } from "./booking-limits.service";
import { canManageGroups } from "./group-context.service";
import { GroupError } from "./group.service";

// The application-wide booking policies (one row). Only someone who may manage
// groups (the Admin role, or a group that grants group.manage) may read or
// change them. Changing them never edits a group or an existing meeting: the
// stricter of the application's and a group's value is applied when someone
// books, so a lowered application limit tightens new bookings and reschedules
// only.

export const APP_BOOKING_POLICY_AUDIT = "APP_BOOKING_POLICY_CHANGED";

export type AppBookingSettings = AppBookingPolicy & {
  // Groups whose own stored values are now looser than the application's, so
  // the application's value is the one in force for them (informational).
  groupsAboveLimits: string[];
};

async function assertMayManageGroups(actorEmployeeId: number) {
  const [row] = await db
    .select({ role: roles.roleName })
    .from(employee)
    .innerJoin(roles, eq(roles.roleId, employee.role_id))
    .where(eq(employee.employee_id, actorEmployeeId));

  if (!row || !(await canManageGroups(actorEmployeeId, row.role))) {
    throw new GroupError(
      "You do not have permission to change the application booking policies.",
      403
    );
  }
}

async function groupsLooserThan(app: AppBookingPolicy): Promise<string[]> {
  const rows = await db
    .select({ name: groups.name, s: groupSettings })
    .from(groupSettings)
    .innerJoin(groups, eq(groups.id, groupSettings.groupId));

  return rows
    .filter(({ s }) => {
      const above = (appValue: number | null, groupValue: number | null) =>
        appValue !== null && groupValue !== null && groupValue > appValue;

      return (
        above(app.maxDurationMinutes, s.maxDurationMinutes) ||
        above(app.maxBookingsPerDay, s.maxBookingsPerDay) ||
        above(app.maxBookingsPerWeek, s.maxBookingsPerWeek) ||
        above(app.maxBookingsPerMonth, s.maxBookingsPerMonth) ||
        (!app.allowOvernight && s.overnightPolicy === "ALLOWED")
      );
    })
    .map((r) => r.name)
    .sort();
}

export async function getAppBookingSettings(): Promise<AppBookingSettings> {
  const policy = await getAppBookingPolicy();

  return { ...policy, groupsAboveLimits: await groupsLooserThan(policy) };
}

export async function updateAppBookingSettings(
  input: AppBookingSettingsInput,
  actorEmployeeId: number
): Promise<AppBookingSettings> {
  await assertMayManageGroups(actorEmployeeId);

  await db.transaction(async (tx) => {
    // Locked so two admins saving at once each get an accurate before/after.
    await tx
      .insert(appBookingSettings)
      .values({ id: 1 })
      .onConflictDoNothing();

    const [before] = await tx
      .select()
      .from(appBookingSettings)
      .where(eq(appBookingSettings.id, 1))
      .for("update");

    const previous: AppBookingPolicy = {
      allowOvernight: before.allowOvernight,
      maxDurationMinutes: before.maxDurationMinutes,
      maxBookingsPerDay: before.maxBookingsPerDay,
      maxBookingsPerWeek: before.maxBookingsPerWeek,
      maxBookingsPerMonth: before.maxBookingsPerMonth,
    };

    if (JSON.stringify(previous) === JSON.stringify(input)) return;

    await tx
      .update(appBookingSettings)
      .set({ ...input, updatedAt: new Date(), updatedBy: actorEmployeeId })
      .where(eq(appBookingSettings.id, 1));

    await tx.insert(groupAuditLogs).values({
      actorEmployeeId,
      action: APP_BOOKING_POLICY_AUDIT,
      details: { before: previous, after: input },
    });
  });

  return getAppBookingSettings();
}
