"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";

import {
  CalendarPlus,
  Building2,
  ArrowRight,
} from "lucide-react";

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
  userProfile: UserProfile;
};

export default function HeroSection({
  userProfile,
}: Props) {
  const router = useRouter();

  return (
    <section className="mx-auto mt-10 max-w-7xl px-6">

      <div className="overflow-hidden rounded-3xl bg-gradient-to-r from-blue-700 via-blue-600 to-cyan-600 shadow-2xl">

        <div className="grid items-center gap-10 p-10 lg:grid-cols-2">

          {/* Left */}

          <div>

            <p className="text-lg font-medium text-cyan-100">
              Welcome Back,
            </p>

            <h1 className="mt-2 text-5xl font-bold text-white leading-tight">
              {userProfile.name} 👋
            </h1>

            <h2 className="mt-8 text-3xl font-semibold text-white">
              Smart Meeting Scheduling Platform
            </h2>

            <p className="mt-6 max-w-xl text-lg leading-8 text-blue-100">

              Reserve meeting rooms, manage bookings,
              collaborate with your colleagues and receive
              automatic email notifications from one
              centralized platform.

            </p>

            <div className="mt-10 flex flex-wrap gap-4">

              <Button
                size="lg"
                className="bg-white text-blue-700 hover:bg-slate-100"
                onClick={() => router.push("/booking")}
              >
                <CalendarPlus className="mr-2 h-5 w-5" />

                Book Meeting
              </Button>

              <Button
                size="lg"
                variant="outline"
                className="border-white bg-transparent text-white hover:bg-white hover:text-blue-700"
                onClick={() => router.push("/rooms")}
              >
                <Building2 className="mr-2 h-5 w-5" />

                View Rooms

                <ArrowRight className="ml-2 h-4 w-4" />

              </Button>

            </div>

          </div>

          {/* Right */}

          <div className="flex justify-center">

            <Image
              src="/images/login-room.png"
              alt="Meeting Room"
              width={520}
              height={420}
              priority
              className="rounded-3xl border-4 border-white/20 object-cover shadow-2xl"
            />

          </div>

        </div>

      </div>

    </section>
  );
}