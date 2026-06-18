import { db } from "@/app/db";
import { users } from "@/app/db/schema";

export async function GET() {
  const result = await db.select().from(users);

  return Response.json(result);
}