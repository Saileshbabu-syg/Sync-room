import { jsonError, rateLimit } from "@/lib/api";
import { PERMISSION } from "@/lib/constants";
import { parseDashboardFilters } from "@/lib/dashboard-params";
import { requirePermission } from "@/lib/permissions";
import {
  createReportStream,
  REPORT_CONTENT_TYPES,
  ReportError,
  reportFilename,
  type ReportFormat,
} from "@/lib/services/report.service";

const FORMATS: ReportFormat[] = ["csv", "xlsx", "pdf"];

// Report download for the currently selected dashboard filters. Same
// permission as the dashboard, checked here again for every download. A
// selection over the row limit is refused (422) before anything is generated;
// every export is recorded in the audit log.
export async function GET(request: Request) {
  try {
    const guard = await requirePermission(PERMISSION.DASHBOARD_VIEW);

    if (!guard.ok) return guard.response;

    const blocked = rateLimit(guard.organizer.employeeId, "dashreport", 10);

    if (blocked) return blocked;

    const { searchParams } = new URL(request.url);
    const format = searchParams.get("format") as ReportFormat | null;

    if (!format || !FORMATS.includes(format)) {
      return jsonError(400, "format must be csv, xlsx or pdf.");
    }

    const parsed = parseDashboardFilters(searchParams);

    if (!parsed.ok) return jsonError(400, parsed.message);

    const stream = await createReportStream(
      format,
      parsed.filters,
      `${guard.organizer.name} <${guard.organizer.email}>`,
      { actorEmployeeId: guard.organizer.employeeId }
    );

    return new Response(stream, {
      headers: {
        "Content-Type": REPORT_CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${reportFilename(parsed.filters, format)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ReportError) return jsonError(error.status, error.message);

    console.error(error);

    return jsonError(500, "Something went wrong.");
  }
}
