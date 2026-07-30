import { ReactNode } from "react";

import BookingHeader from "./BookingHeader";
import BookingSidebar from "./BookingSidebar";

import { Session } from "next-auth";

type UserProfile = {
  organizerId: number;
  employeeId: number;
  name: string;
  email: string;
  role: string;
  imageUrl: string | null;
};

type Props = {
  children: ReactNode;
  session: Session;
  userProfile: UserProfile;
};

export default function BookingLayout({
  children,
  session,
  userProfile,
}: Props) {
  return (
    <main className="min-h-screen bg-slate-100">

      {/* Header */}

      <BookingHeader
  title="Book Meeting"
  session={session}
  userProfile={userProfile}
/>

      {/* Content */}

      <div className="flex h-[calc(100vh-64px)]">

        {/* Sidebar */}

        <BookingSidebar />

        {/* Main Content */}

        <section className="flex-1 overflow-y-auto p-8">

          <div className="rounded-3xl bg-white p-8 shadow-sm">

            {children}

          </div>

        </section>

      </div>

    </main>
  );
}