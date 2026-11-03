import { NextResponse } from "next/server";

import { jsonError, parseIdParam } from "@/lib/api";
import { requireGroupManagement } from "@/lib/permissions";
import { listEmployees } from "@/lib/services/group.service";

export async function GET(request: Request) {
  const guard = await requireGroupManagement();

  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);

  const rawGroup = searchParams.get("groupId");
  const groupId =
    rawGroup === null || rawGroup === ""
      ? undefined
      : rawGroup === "none"
        ? ("none" as const)
        : (parseIdParam(rawGroup) ?? undefined);

  if (rawGroup && groupId === undefined) {
    return jsonError(400, "Invalid group filter.");
  }

  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize")) || 20)
  );

  const result = await listEmployees({
    search: searchParams.get("search")?.slice(0, 100) ?? undefined,
    groupId,
    page,
    pageSize,
  });

  return NextResponse.json({ success: true, page, pageSize, ...result });
}
