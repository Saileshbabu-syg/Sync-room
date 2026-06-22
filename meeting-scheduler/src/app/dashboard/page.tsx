import { auth } from "@/auth";
import LogoutButton from "@/components/LogoutButton";
import { redirect } from "next/navigation";

import Link from "next/link";

export default async function DashboardPage() {
  const session = await auth();
  console.log("SESSION:", session);


  if (!session) {
    redirect("/login");
  }

  return (
    <div>
      <h1>Dashboard</h1>

      <p>Name: {session?.user?.name}</p>

      <p>Email: {session?.user?.email}</p>

      <LogoutButton />

      

<Link href="/profile">View Profile</Link>
    </div>
  );
}