import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizers } from "@/db/schema/organizer";

import { eq } from "drizzle-orm";

import {
  getUpcomingMeeting,
  getTodayMeetings,
} from "@/lib/services/dashboard.service";

import HomeHeader from "@/components/HomeHeader";
import HeroSection from "@/components/HeroSection";
import UpcomingMeetingCard from "@/components/UpcomingMeetingCard";
import TodaySchedule from "@/components/TodaySchedule";
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
    .where(
      eq(
        organizers.email,
        session.user!.email!
      )
    );

  const upcomingMeeting =
    await getUpcomingMeeting(
      userProfile[0].employeeId
    );

  const todayMeetings =
    await getTodayMeetings(
      userProfile[0].employeeId
    );

  return (

    <main className="min-h-screen bg-slate-100">

      <HomeHeader
        session={session}
        userProfile={userProfile[0]}
      />

      <HeroSection
        userProfile={userProfile[0]}
      />

      <section className="mx-auto mt-10 max-w-7xl px-6">

  <div className="grid gap-6 lg:grid-cols-2">

    <UpcomingMeetingCard
      meeting={upcomingMeeting}
    />

    <TodaySchedule
      meetings={todayMeetings}
    />

  </div>

</section>

      <QuickActions />

      <FeaturesSection />

      <Footer />

    </main>

  );

}