import { Bell } from "lucide-react";
import { Session } from "next-auth";

import UserSheet from "./UserSheet";

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
};

export default function HomeHeader({
  session,
  userProfile,
}: Props) {
  return (
    <header className="sticky top-0 z-50 border-b bg-white shadow-sm">

      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">

        {/* Logo */}

        <div className="flex items-center gap-3">

          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">
            M
          </div>

          <div>

            <h1 className="text-2xl font-bold text-blue-700">
              MeetSched
            </h1>

            <p className="text-sm text-gray-500">
              Smart Meeting Scheduler
            </p>

          </div>

        </div>

        {/* Title */}

        <h2 className="hidden text-4xl font-bold text-slate-700 md:block">
          Smart Scheduling
        </h2>

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