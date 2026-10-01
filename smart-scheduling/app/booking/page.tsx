import { auth } from "@/auth";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { organizers } from "@/db/schema";
import { eq } from "drizzle-orm";

import BookingLayout from "@/components/BookingLayout";
import BookingForm from "@/components/BookingForm";

export default async function BookingPage() {
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
    <BookingLayout
      session={session}
      userProfile={userProfile[0]}
    >
      <BookingForm />
    </BookingLayout>
  );
}