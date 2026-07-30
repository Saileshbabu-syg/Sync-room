import { auth } from "@/auth";
import { redirect } from "next/navigation";
import UserMenu from "@/components/UserMenu";

export default async function DashboardPage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-slate-100">

      {/* Header */}
      <header className="flex items-center justify-between border-b bg-white px-6 py-4 shadow-sm">

        <h1 className="text-2xl font-bold text-blue-700">
          MeetSched Dashboard
        </h1>

        <UserMenu session={session} />

      </header>

      {/* Dashboard Content */}

      <main className="p-8">

        <h2 className="text-3xl font-bold">
          Welcome 👋
        </h2>

        <p className="mt-2 text-gray-600">
          Manage meetings and conference rooms from your dashboard.
        </p>

      </main>

    </div>
  );
}