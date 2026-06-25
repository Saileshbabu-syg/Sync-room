
import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/app/db";
import { organizers } from "@/app/db/schema";
import { eq } from "drizzle-orm";

export default async function ProfilePage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const userData = await db
    .select({
      name: organizers.name,
      email: organizers.email,
      role: organizers.role,
      imageUrl: organizers.imageUrl,
      employeeId: organizers.employeeId,
    })
    .from(organizers)
    .where(eq(organizers.email, session.user!.email!));

  if (userData.length === 0) {
    return <h1>User Not Found</h1>;
  }

  return (
    <div>
      <h1>Profile</h1>

      {userData[0].imageUrl && (
        <img
          src={userData[0].imageUrl}
          alt="Profile"
          width={100}
          height={100}
        />
      )}

      <p>Name: {userData[0].name}</p>

      <p>Email: {userData[0].email}</p>

      <p>Role: {userData[0].role}</p>

      <p>Employee ID: {userData[0].employeeId}</p>
    </div>
  );
} 