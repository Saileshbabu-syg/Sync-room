import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { getAppBookingSettings } from "@/lib/services/booking-settings.service";
import {
  listGroups,
  listMeetingTypes,
  listRoomOptions,
} from "@/lib/services/group.service";

import GroupManagement from "@/components/GroupManagement";

export default async function GroupManagementPage() {
  const session = await auth();

  if (!session) redirect("/login");

  const currentUser = await getCurrentUserProfile();

  if (!currentUser) redirect("/login");

  // Needs the Group Management permission (Admins always have it). The
  // /api/admin/* routes check this again on every request.
  if (!currentUser.canManageGroups) redirect("/home");

  const [groups, meetingTypes, rooms, appSettings] = await Promise.all([
    listGroups(),
    listMeetingTypes(),
    listRoomOptions(),
    getAppBookingSettings(),
  ]);

  return (
    <GroupManagement
      initialGroups={groups.map((g) => ({
        ...g,
        createdAt: g.createdAt.toISOString(),
      }))}
      meetingTypes={meetingTypes}
      rooms={rooms}
      initialAppSettings={appSettings}
    />
  );
}
