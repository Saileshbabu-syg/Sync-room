import { parseIdParam } from "@/lib/api";
import { PeriodError, resolvePeriod } from "@/lib/report-period";
import {
  VALID_STATUS_IDS,
  type DashboardFilters,
} from "@/lib/services/booking-dashboard.service";

// One parser for the dashboard and the report download, so both always apply
// the same filters to the same query string.
export function parseDashboardFilters(
  params: URLSearchParams
): { ok: true; filters: DashboardFilters } | { ok: false; message: string } {
  try {
    const period = resolvePeriod({
      mode: params.get("mode"),
      date: params.get("date"),
      start: params.get("start"),
      end: params.get("end"),
    });

    const optionalId = (name: string) => {
      const raw = params.get(name);

      if (!raw) return undefined;

      const id = parseIdParam(raw);

      if (id === null) throw new PeriodError(`Invalid ${name}.`);

      return id;
    };

    const statusId = optionalId("statusId");

    if (statusId !== undefined && !VALID_STATUS_IDS.includes(statusId)) {
      return { ok: false, message: "Invalid statusId." };
    }

    return {
      ok: true,
      filters: {
        period,
        groupId: optionalId("groupId"),
        roomId: optionalId("roomId"),
        statusId,
        search: params.get("q")?.trim().slice(0, 100) || undefined,
        sort: params.get("sort") === "asc" ? "asc" : "desc",
      },
    };
  } catch (error) {
    if (error instanceof PeriodError) {
      return { ok: false, message: error.message };
    }

    throw error;
  }
}
