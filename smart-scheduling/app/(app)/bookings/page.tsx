import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import { MEETING_STATUS_LABEL, ROLE_ADMIN } from "@/lib/constants";
import { listMyBookings } from "@/lib/services/my-bookings.service";

import BookingTabs from "@/components/BookingTabs";

export default async function MyBookingsPage() {

  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

  // The signed-in employee (from the session, never from the request) sees the
  // meetings they organize and the ones they were added to as a participant.
  const rows = await listMyBookings(userProfile[0].employeeId);

  // The label comes from the status id, not from how the name is spelled or
  // cased in the database.
  // Only the organizer (or an Admin) may edit or cancel; participants can
  // view. The edit and cancel endpoints enforce this again on the server.
  const meetings = rows.map(({ organizerEmployeeId, ...row }) => ({
    ...row,
    canManage:
      organizerEmployeeId === userProfile[0].employeeId ||
      userProfile[0].role === ROLE_ADMIN,
    meetingStatus:
      MEETING_STATUS_LABEL[row.meetingStatusId] ?? row.meetingStatus,
  }));

  return (
    <>

      <div className="space-y-8">

        <div>

          <h1 className="text-3xl font-bold">
            My Bookings
          </h1>

          <p className="mt-2 text-gray-500">
            View and manage all your meetings.
          </p>

        </div>

        <BookingTabs
          meetings={meetings}
        />

      </div>

    </>
  );
}