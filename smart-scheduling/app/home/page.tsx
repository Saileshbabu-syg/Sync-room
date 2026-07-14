import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizers } from "@/db/schema/organizer";
import { eq } from "drizzle-orm";

import HomeHeader from "@/components/HomeHeader";
import HeroSection from "@/components/HeroSection";
import QuickActions from "@/components/QuickActions";
import FeaturesSection from "@/components/FeaturesSection";
import Footer from "@/components/Footer";

export default async function HomePage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const userProfile = await db
  .select({
    organizerId: organizers.organizerId,
    employeeId: organizers.employeeId,
    name: organizers.name,
    email: organizers.email,
    role: organizers.role,
    imageUrl: organizers.imageUrl,
  })
  .from(organizers)
  .where(eq(organizers.email, session.user!.email!));

  return (
    <main className="min-h-screen bg-slate-100">

      <HomeHeader
  session={session}
  userProfile={userProfile[0]}
/>

      <HeroSection userProfile={userProfile[0]} />

      <QuickActions />

      <FeaturesSection />

      <Footer />

    </main>
  );
}