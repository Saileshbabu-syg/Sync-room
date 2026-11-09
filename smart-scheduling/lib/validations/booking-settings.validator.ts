import { z } from "zod";

// Application-wide booking policies. Every number is optional-or-null:
// null = unlimited. They are the upper boundary for every group (the stricter
// of the application's and the group's value applies, lib/booking-limits.ts).
const limit = (min: number, max: number, what: string) =>
  z
    .number({ error: `${what} must be a number.` })
    .int(`${what} must be a whole number.`)
    .min(min, `${what} must be at least ${min}.`)
    .max(max, `${what} must be at most ${max}.`)
    .nullable();

export const appBookingSettingsSchema = z.object({
  allowOvernight: z.boolean({ error: "Allow overnight bookings must be on or off." }),
  // Minutes; the form offers hours and minutes.
  maxDurationMinutes: limit(15, 1440, "Maximum meeting duration (minutes)"),
  maxBookingsPerDay: limit(1, 1000, "Maximum bookings per day"),
  maxBookingsPerWeek: limit(1, 5000, "Maximum bookings per week"),
  maxBookingsPerMonth: limit(1, 20000, "Maximum bookings per month"),
});

export type AppBookingSettingsInput = z.infer<typeof appBookingSettingsSchema>;
