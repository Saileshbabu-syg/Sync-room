import { redirect } from "next/navigation";

import { auth } from "@/auth";
import EditRoomForm from "@/components/EditRoomForm";
import { db } from "@/db";
import { availabilityMaster } from "@/db/schema";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { AVAILABILITY_STATUS } from "@/lib/constants";

// Adding a room (room managers only; POST /api/rooms checks the same).
export default async function NewRoomPage() {
  const session = await auth();

  if (!session) redirect("/login");

  const currentUser = await getCurrentUserProfile();

  if (!currentUser) redirect("/login");

  if (!currentUser.canManageRooms) redirect("/rooms");

  const availabilityStatuses = (
    await db
      .select({
        availabilityStatusId: availabilityMaster.availabilityStatusId,
        availabilityStatusName: availabilityMaster.availabilityStatusCode,
      })
      .from(availabilityMaster)
  ).map((status) => ({
    availabilityStatusId: status.availabilityStatusId,
    availabilityStatusName: status.availabilityStatusName ?? "",
  }));

  return (
    <EditRoomForm
      mode="create"
      room={{
        room_id: 0,
        room_name: "",
        room_capacity: 1,
        roomLocation: "",
        facilities: "",
        roomDescription: "",
        availabilityStatusId: AVAILABILITY_STATUS.AVAILABLE,
      }}
      availabilityStatuses={availabilityStatuses}
    />
  );
}
