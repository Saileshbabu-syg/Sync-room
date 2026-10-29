"use client";

import { Session } from "next-auth";

import UserSheet from "@/components/UserSheet";
import { Button } from "@/components/ui/button";

type UserProfile = {
  organizerId: number;
  employeeId: number;
  name: string;
  email: string;
  role: string;
  imageUrl: string | null;
};

type Props = {
  session: Session;
  userProfile: UserProfile;
  title: string;
};

export default function BookingHeader({
  session,
  userProfile,
  title,
}: Props) {
  return (
    <header className="sticky top-0 z-50 border-b bg-white shadow-sm">

      <div className="mx-auto flex h-16 items-center justify-between px-6">

        {/* Left */}

        <div>

          <h1 className="text-2xl font-bold text-blue-700">
            {title}
          </h1>

          <p className="text-sm text-gray-500">
            Smart Meeting Scheduling Platform
          </p>

        </div>

        {/* Right */}

        <div className="flex items-center gap-3">

          <Button
            variant="ghost"
            size="icon"
          >
            {/* <Bell className="h-5 w-5" /> */}
          </Button>

          <UserSheet
            session={session}
            userProfile={userProfile}
          />

        </div>

      </div>

    </header>
  );
}