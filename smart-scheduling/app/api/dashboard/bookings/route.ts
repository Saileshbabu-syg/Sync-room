import { NextResponse } from "next/server";

import { jsonError, rateLimit } from "@/lib/api";
import { PERMISSION } from "@/lib/constants";
import { parseDashboardFilters } from "@/lib/dashboard-params";
import { requirePermission } from "@/lib/permissions";
import {
  getDashboardMetrics,
  listDashboardBookings,
} from "@/lib/services/booking-dashboard.service";

// Organization-wide booking history. Authorized by the group permission
// dashboard.view on every request, not by hiding the page.
export async function GET(request: Request) {
  try {
    const guard = await requirePermission(PERMISSION.DASHBOARD_VIEW);

    if (!guard.ok) return guard.response;

    const blocked = rateLimit(guard.organizer.employeeId, "dashboard", 120);

    if (blocked) return blocked;

    const { searchParams } = new URL(request.url);
    const parsed = parseDashboardFilters(searchParams);

    if (!parsed.ok) return jsonError(400, parsed.message);

    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(searchParams.get("pageSize")) || 25)
    );

    const [metrics, list] = await Promise.all([
      getDashboardMetrics(parsed.filters),
      listDashboardBookings(parsed.filters, page, pageSize),
    ]);

    return NextResponse.json({
      success: true,
      period: parsed.filters.period,
      metrics,
      page,
      pageSize,
      total: list.total,
      rows: list.rows,
    });
  } catch (error) {
    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
