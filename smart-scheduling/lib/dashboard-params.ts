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

    const sort = params.get("sort") || "desc";

    if (sort !== "asc" && sort !== "desc") {
      return { ok: false, message: "sort must be asc or desc." };
    }

    const search = params.get("q")?.trim() ?? "";

    if (search.length > MAX_SEARCH_LENGTH) {
      return { ok: false, message: `The search may be at most ${MAX_SEARCH_LENGTH} characters.` };
    }

    return {
      ok: true,
      filters: {
        period,
        groupId: optionalId("groupId"),
        roomId: optionalId("roomId"),
        statusId,
        search: search || undefined,
        sort,
      },
    };
  } catch (error) {
    if (error instanceof PeriodError) {
      return { ok: false, message: error.message };
    }

    throw error;
  }
}

export const MAX_SEARCH_LENGTH = 100;
export const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 100_000;

// page and pageSize for a paginated list: absent means the default, anything
// else must be a whole number in range ("abc", "1.5", "-1", "0", "1e3" and
// pageSize 500 are refused, not quietly replaced).
export function parsePaging(
  params: URLSearchParams,
  defaultPageSize = 25
): { ok: true; page: number; pageSize: number } | { ok: false; message: string } {
  const read = (name: string, fallback: number, max: number) => {
    const raw = params.get(name);

    if (raw === null || raw === "") return fallback;
    if (!/^\d{1,6}$/.test(raw)) return null;

    const value = Number(raw);

    return value >= 1 && value <= max ? value : null;
  };

  const page = read("page", 1, MAX_PAGE);

  if (page === null) return { ok: false, message: `page must be a whole number from 1 to ${MAX_PAGE}.` };

  const pageSize = read("pageSize", defaultPageSize, MAX_PAGE_SIZE);

  if (pageSize === null) {
    return { ok: false, message: `pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE}.` };
  }

  return { ok: true, page, pageSize };
}
