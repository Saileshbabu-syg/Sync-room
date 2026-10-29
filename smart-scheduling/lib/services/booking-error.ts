import type { OverlappingMeeting } from "./priority.service";

// Kept in its own module so booking.service and bump.service can both throw it
// without importing each other.
export class BookingError extends Error {
  status: number;
  conflicts?: string[];
  // Every date the series would have used, so the caller can show which
  // occurrences are free and which are taken.
  occurrenceDates?: string[];
  // Machine-readable reason for callers that branch on it (the bump flow).
  code?: string;
  // The meetings a bump would displace, for the confirm dialog.
  victims?: OverlappingMeeting[];

  constructor(
    message: string,
    status: number,
    conflicts?: string[],
    occurrenceDates?: string[],
    extra: { code?: string; victims?: OverlappingMeeting[] } = {}
  ) {
    super(message);
    this.name = "BookingError";
    this.status = status;
    this.conflicts = conflicts;
    this.occurrenceDates = occurrenceDates;
    this.code = extra.code;
    this.victims = extra.victims;
  }
}
