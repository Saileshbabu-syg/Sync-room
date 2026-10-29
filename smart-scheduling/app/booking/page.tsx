import { auth } from "@/auth";
import { getCurrentUserProfile } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";


import BookingLayout from "@/components/BookingLayout";
import BookingForm from "@/components/BookingForm";

export default async function BookingPage() {
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

  return (
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <BookingForm />
    </BookingLayout>
  );
}