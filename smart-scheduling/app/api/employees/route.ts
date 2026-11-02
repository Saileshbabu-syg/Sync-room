import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { employee, roles } from "@/db/schema";
import { getCurrentOrganizer } from "@/lib/auth-helpers";

export async function GET() {
  try {
    const organizer = await getCurrentOrganizer();

    if (!organizer) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const data = await db
      .select({
        employeeId: employee.employee_id,
        name: employee.employee_name,
        role: roles.roleName,
      })
      .from(employee)
      .innerJoin(roles, eq(roles.roleId, employee.role_id))
      .orderBy(asc(employee.employee_name));

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { success: false, message: "Failed to fetch employees" },
      { status: 500 }
    );
  }
}
