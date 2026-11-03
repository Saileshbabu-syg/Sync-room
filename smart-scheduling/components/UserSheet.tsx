"use client";

import { signOut } from "next-auth/react";
import { Session } from "next-auth";
import {
  BadgeCheck,
  LogOut,
  Mail,
  Shield,
} from "lucide-react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

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

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");

export default function UserSheet({ userProfile }: Props) {
  const details = [
    { icon: Mail, label: "Email", value: userProfile.email },
    { icon: BadgeCheck, label: "Employee ID", value: String(userProfile.employeeId) },
    { icon: Shield, label: "Role", value: userProfile.role },
  ];

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open account details"
          className="rounded-full focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Avatar className="h-10 w-10 cursor-pointer ring-2 ring-transparent transition hover:ring-blue-200">
            <AvatarImage src={userProfile.imageUrl ?? ""} alt="" />
            <AvatarFallback className="bg-blue-600 text-sm font-semibold text-white">
              {initials(userProfile.name)}
            </AvatarFallback>
          </Avatar>
        </button>
      </SheetTrigger>

      <SheetContent side="right" className="w-[360px] gap-0 overflow-y-auto p-0 sm:max-w-[360px]">
        <SheetHeader className="sr-only">
          <SheetTitle>My Account</SheetTitle>
          <SheetDescription>Your profile and account details.</SheetDescription>
        </SheetHeader>

        {/* Banner and identity */}

        <div className="h-28 bg-gradient-to-r from-blue-600 via-blue-500 to-indigo-500" />

        <div className="-mt-12 px-6">
          <Avatar className="h-24 w-24 ring-4 ring-white">
            <AvatarImage src={userProfile.imageUrl ?? ""} alt={userProfile.name} />
            <AvatarFallback className="bg-slate-100 text-2xl font-semibold text-slate-700">
              {initials(userProfile.name)}
            </AvatarFallback>
          </Avatar>

          <h2 className="mt-4 text-xl font-bold tracking-tight">
            {userProfile.name}
          </h2>

          <p className="text-sm text-muted-foreground">{userProfile.email}</p>

          <div className="mt-3 flex flex-wrap gap-2">
            <Badge>{userProfile.role}</Badge>
          </div>
        </div>

        {/* Details */}

        <div className="mt-6 px-6">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Account details
          </h3>

          <ul className="divide-y rounded-xl border bg-white">
            {details.map(({ icon: Icon, label, value }) => (
              <li key={label} className="flex items-center gap-3 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                  <Icon className="h-4 w-4" />
                </span>

                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="truncate text-sm font-medium" title={value}>
                    {value}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Sign out */}

        <div className="mt-auto p-6">
          <Button
            variant="outline"
            className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={() => signOut({ callbackUrl: "/login" })}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
