"use client";

import { signOut } from "next-auth/react";
import { Session } from "next-auth";
import { UserCircle2 } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { Button } from "@/components/ui/button";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";

import { Separator } from "@/components/ui/separator";

import {
  Mail,
  BadgeCheck,
  Shield,
  LogOut,
  Menu,
} from "lucide-react";

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

export default function UserSheet({
  session,
  userProfile,
}: Props) {
  return (
    <Sheet>
      <SheetTrigger asChild>
  <UserCircle2 className="h-10 w-10 cursor-pointer text-gray-700 hover:text-black transition-colors" />
</SheetTrigger>

      <SheetContent
        side="right"
        className="w-[340px]"
      >
        <SheetHeader>
          <SheetTitle>
            My Account
          </SheetTitle>
        </SheetHeader>

        {/* Profile */}

        <div className="mt-8 flex flex-col items-center">

          <Avatar className="h-24 w-24">

            <AvatarImage
              src={userProfile.imageUrl ?? ""}
              alt="Profile"
            />

            <AvatarFallback className="text-xl font-semibold">
              {userProfile.name
                .split(" ")
                .map((word) => word[0])
                .join("")}
            </AvatarFallback>

          </Avatar>

          <h2 className="mt-4 text-xl font-bold">
            {userProfile.name}
          </h2>

          <p className="text-center text-sm text-muted-foreground">
            {userProfile.email}
          </p>

        </div>

        <Separator className="my-8" />

        {/* User Details */}

        <div className="space-y-6">

          <div className="flex items-start gap-3">

            <Mail className="mt-1 h-5 w-5 text-blue-600" />

            <div>

              <p className="text-xs text-gray-500">
                Email
              </p>

              <p className="font-medium">
                {userProfile.email}
              </p>

            </div>

          </div>

          <div className="flex items-start gap-3">

            <BadgeCheck className="mt-1 h-5 w-5 text-blue-600" />

            <div>

              <p className="text-xs text-gray-500">
                Employee ID
              </p>

              <p className="font-medium">
                {userProfile.employeeId }
              </p>

            </div>

          </div>

          <div className="flex items-start gap-3">

            <Shield className="mt-1 h-5 w-5 text-blue-600" />

            <div>

              <p className="text-xs text-gray-500">
                Role
              </p>

              <p className="font-medium">
                {userProfile.role}
              </p>

            </div>

          </div>

        </div>

        <Separator className="my-8" />

        {/* Logout */}

        <Button
          className="w-full bg-red-600 hover:bg-red-700"
          onClick={() =>
            signOut({
              callbackUrl: "/login",
            })
          }
        >
          <LogOut className="mr-2 h-4 w-4" />

          Logout

        </Button>

      </SheetContent>
    </Sheet>
  );
}