import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";



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

  const currentUser = await getCurrentUserProfile();

  // Signed in, but no longer a known employee (removed or email changed):
  // treat as signed out instead of crashing on a missing profile.
  if (!currentUser) {
    redirect("/login");
  }

  const userProfile = [currentUser];

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