import { NextResponse } from "next/server";

import { getCurrentOrganizer } from "@/lib/auth-helpers";
import { getBookingPolicy } from "@/lib/services/booking-policy.service";

// What the signed-in person's group allows, so the booking form can hide or
// limit what they cannot do. Advisory only: createBooking enforces every rule
// again, from the database.
export async function GET() {
  const organizer = await getCurrentOrganizer();

  if (!organizer) {
    return NextResponse.json(
      { success: false, message: "Unauthorized" },
      { status: 401 }
    );
  }

  const policy = await getBookingPolicy(organizer.employeeId);

  return NextResponse.json({
    success: true,
    policy: {
      canBookRecurring: policy.canBookRecurring,
      maxDurationMinutes: policy.maxDurationMinutes,
      maxAdvanceDays: policy.maxAdvanceDays,
      maxOccurrences: policy.maxOccurrences,
    },
  });
}
