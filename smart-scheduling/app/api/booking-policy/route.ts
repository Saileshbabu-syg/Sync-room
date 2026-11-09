import { NextResponse } from "next/server";

import { db } from "@/db";
import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { PERMISSION } from "@/lib/constants";
import { hasMemberWithPermission } from "@/lib/services/priority.service";
import { getBookingPolicy } from "@/lib/services/booking-policy.service";
import { isOnlineMeetingAvailable } from "@/lib/services/teams-meeting.service";

// What the signed-in person's group allows, so the booking form can hide or
// limit what they cannot do. Advisory only: createBooking enforces every rule
// again, from the database.
export async function GET(request: Request) {
  const organizer = await getCurrentOrganizer();

  if (!organizer) {
    return NextResponse.json(
      { success: false, message: "Unauthorized" },
      { status: 401 }
    );
  }

  // Optional `attendees=1,2,3`: the invited people, so a priority guest (a
  // member of a group with booking.outranks) is seen the way createBooking
  // will see them.
  const invited = (new URL(request.url).searchParams.get("attendees") ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);

  const [policy, priorityGuest] = await Promise.all([
    getBookingPolicy(organizer.employeeId),
    hasMemberWithPermission(db, [organizer.employeeId, ...invited], PERMISSION.BOOKING_OUTRANKS),
  ]);

  return NextResponse.json({
    success: true,
    // A priority guest outranks every meeting type (see priority.service).
    priorityGuest,
    policy: {
      canBookRecurring: policy.canBookRecurring,
      maxDurationMinutes: policy.maxDurationMinutes,
      maxAdvanceDays: policy.maxAdvanceDays,
      maxOccurrences: policy.maxOccurrences,
      // The effective booking policies (application and group combined) for
      // the form to show; null = no limit.
      allowOvernight: policy.allowOvernight,
      maxBookingsPerDay: policy.limits.perDay.value,
      maxBookingsPerWeek: policy.limits.perWeek.value,
      maxBookingsPerMonth: policy.limits.perMonth.value,
    },
    // Whether the server has the Teams integration configured, so the form
    // only offers "Online Teams Meeting" when it can work.
    onlineMeetingAvailable: isOnlineMeetingAvailable(),
  });
}
