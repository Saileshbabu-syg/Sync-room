import { auth } from "@/auth";
import { parseIdParam } from "@/lib/api";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";

import {
  MEETING_STATUS,
  MEETING_STATUS_LABEL,
  PERMISSION,
  ROLE_ADMIN,
} from "@/lib/constants";
import { getPriorityContext } from "@/lib/services/group-context.service";
import { getBumpInfo } from "@/lib/services/bump-info.service";
import {
  countMyBookingsByTab,
  isBookingTab,
  listMyBookingsPage,
} from "@/lib/services/my-bookings.service";
import { DATE_REGEX, isValidCalendarDate } from "@/lib/validations/date-time";

import BookingTabs from "@/components/BookingTabs";

const PAGE_SIZE = 10;

type Props = {
  searchParams: Promise<{ tab?: string; date?: string; page?: string }>;
};

export default async function MyBookingsPage({ searchParams }: Props) {

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

  // Group permission, re-read from the database on every request.
  const standing = await getPriorityContext(currentUser.employeeId);

  if (!standing.permissions.has(PERMISSION.BOOKING_VIEW)) {
    redirect("/home");
  }

  // Tab, day filter and page come from the URL (shareable, survives a
  // refresh). Anything malformed falls back to the default instead of failing.
  const params = await searchParams;
  const tab = isBookingTab(params.tab) ? params.tab : "scheduled";
  const date =
    params.date && DATE_REGEX.test(params.date) && isValidCalendarDate(params.date)
      ? params.date
      : undefined;

  // The signed-in employee (from the session, never from the request) sees the
  // meetings they organize and the ones they were added to as a participant -
  // one page at a time, counted per tab on the server.
  const counts = await countMyBookingsByTab(currentUser.employeeId, date);
  const pages = Math.max(1, Math.ceil(counts[tab] / PAGE_SIZE));
  const page = Math.min(parseIdParam(params.page) ?? 1, pages);

  const rows = await listMyBookingsPage(currentUser.employeeId, {
    tab,
    date,
    page,
    pageSize: PAGE_SIZE,
  });

  // For bumped meetings: who took the room, and the meeting that replaced it.
  const bumps = await getBumpInfo(
    rows
      .filter((row) => row.meetingStatusId === MEETING_STATUS.PREEMPTED)
      .map((row) => row.meetingId)
  );

  // Only the organizer (or an Admin) may edit or cancel; participants can
  // view. The edit and cancel endpoints enforce this again on the server.
  const meetings = rows.map(({ organizerEmployeeId, ...row }) => ({
    ...row,
    bumped: bumps.get(row.meetingId) ?? null,
    canManage:
      (organizerEmployeeId === currentUser.employeeId ||
        currentUser.role === ROLE_ADMIN) &&
      row.meetingStatusId !== MEETING_STATUS.PREEMPTED,
    // The label comes from the status id, not from how the name is spelled
    // or cased in the database.
    meetingStatus:
      MEETING_STATUS_LABEL[row.meetingStatusId] ?? row.meetingStatus,
  }));

  return (
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
        tab={tab}
        counts={counts}
        date={date ?? ""}
        page={page}
        pages={pages}
      />

    </div>
  );
}
