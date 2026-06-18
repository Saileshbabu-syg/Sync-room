import { db } from "@/app/db";
import { roles } from "@/app/db/schema";

export async function GET() {
  const result = await db.select().from(roles);

  return Response.json(result);
}