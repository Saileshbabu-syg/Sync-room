"use client";

import Link from "next/link";
import { Session } from "next-auth";
import { Menu } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";

import { Separator } from "@/components/ui/separator";
import LogoutButton from "@/components/LogoutButton";
import { Button } from "@/components/ui/button";

type Props = {
  session: Session;
};

export default function UserMenu({ session }: Props) {
  return (
    <Sheet>

      <SheetTrigger asChild>
        <Button variant="ghost" size="icon">
          <Menu className="h-6 w-6" />
        </Button>
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

        <div className="mt-8 flex flex-col items-center">

          <Avatar className="h-24 w-24">

            <AvatarImage
              src={session.user?.image ?? ""}
              alt="Profile"
            />

            <AvatarFallback>
              {session.user?.name?.charAt(0)}
            </AvatarFallback>

          </Avatar>

          <h2 className="mt-4 text-xl font-bold">
            {session.user?.name}
          </h2>

          <p className="text-center text-sm text-muted-foreground">
            {session.user?.email}
          </p>

        </div>

        <Separator className="my-8" />

        <div className="space-y-4">

          <Link href="/profile">

            <Button
              variant="outline"
              className="w-full"
            >
              View Profile
            </Button>

          </Link>

          <LogoutButton />

        </div>

      </SheetContent>

    </Sheet>
  );
}