import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { groups, room } from "@/db/schema";
import { MEETING_STATUS_LABEL, PERMISSION } from "@/lib/constants";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { VALID_STATUS_IDS } from "@/lib/services/booking-dashboard.service";
import { getPriorityContext } from "@/lib/services/group-context.service";
import { nowInAppTimezone } from "@/lib/time";

import BookingDashboard from "@/components/BookingDashboard";

export default async function DashboardPage() {
  const session = await auth();

  if (!session) redirect("/login");

  const currentUser = await getCurrentUserProfile();

  if (!currentUser) redirect("/login");

  // Group permission, read from the database. /api/dashboard/* checks it again.
  const standing = await getPriorityContext(currentUser.employeeId);

  if (!standing.permissions.has(PERMISSION.DASHBOARD_VIEW)) {
    redirect("/home");
  }

  const [groupRows, roomRows] = await Promise.all([
    db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .orderBy(asc(groups.priority), asc(groups.id)),
    db
      .select({ id: room.room_id, name: room.room_name })
      .from(room)
      .orderBy(asc(room.room_name)),
  ]);

  return (
    <BookingDashboard
      today={nowInAppTimezone().date}
      groups={groupRows}
      rooms={roomRows}
      statuses={VALID_STATUS_IDS.map((id) => ({
        id,
        label: MEETING_STATUS_LABEL[id],
      }))}
    />
  );
}
