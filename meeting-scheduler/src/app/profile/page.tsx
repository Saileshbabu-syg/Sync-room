import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/app/db";
import { organizers, roles } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export default async function ProfilePage() {
  const session = await auth();

  const userData = await db
  .select({
    name: organizers.name,
    email: organizers.email,
    role: roles.roleName,
  })
  .from(organizers)
  .leftJoin(roles, eq(organizers.roleId, roles.roleId))
  .where(eq(organizers.email, session!.user!.email!));

  if (!session) {
    redirect("/login");
  }

  return (
    <div>
      <h1>Profile</h1>

      <img
        src={session.user?.image ?? ""}
        alt="Profile"
        width={100}
        height={100}
      />

      <p>Name: {userData[0].name}</p>

<p>Email: {userData[0].email}</p>

<p>Role: {userData[0].role}</p>
    </div>
  );
}