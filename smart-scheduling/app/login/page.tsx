"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { signIn } from "next-auth/react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(false);

  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });

 const hasError =
  searchParams.get("error") === "not-authorized";

useEffect(() => {
  if (hasError) {
    const timer = setTimeout(() => {
      setOpen(true);
    }, 0);

    return () => clearTimeout(timer);
  }
}, [hasError]);

  const handleLogin = async () => {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: formData.email,
        password: formData.password,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      localStorage.setItem(
        "organizer",
        JSON.stringify(data.user)
      );

      window.location.href = "/home";
      return;
    }

    alert(data.message);
  };

  return (
    <div className="min-h-screen grid bg-slate-50 lg:grid-cols-2">

      {/* Left Section */}

      <div className="flex items-center justify-center bg-white px-8 py-10">

        <div className="w-full max-w-md">

          <div className="mb-10">

            <h1 className="text-4xl font-bold text-blue-700">
              MeetSched
            </h1>

            <h2 className="mt-10 text-4xl font-bold tracking-tight">
              Welcome Back
            </h2>

            <p className="mt-3 text-muted-foreground">
              Sign in to your account to continue
            </p>

          </div>

          <div className="space-y-5">

            <Input
              type="email"
              placeholder="Email Address"
              value={formData.email}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  email: e.target.value,
                })
              }
            />

            <Input
              type="password"
              placeholder="Password"
              value={formData.password}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  password: e.target.value,
                })
              }
            />

            <Button
              className="h-11 w-full"
              onClick={handleLogin}
            >
              Login
            </Button>

            <Button
              variant="outline"
              className="h-11 w-full bg-[#155DFC] text-white hover:bg-[#0F4FCC] border-0"
              onClick={() =>
                signIn("google", {
                  callbackUrl: "/home",
                })
              }
            >
              Sign in with Google
            </Button>

          </div>

          <p className="mt-8 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link
              href="/signup"
              className="font-semibold text-blue-700 hover:text-blue-800"
            >
              Sign Up
            </Link>
          </p>

        </div>

      </div>
            {/* Right Section */}

      <div className="relative hidden overflow-hidden bg-slate-900 lg:flex lg:items-center lg:justify-center">

        {/* Background Image */}

        <Image
          src="/images/login-room.png"
          alt="Meeting Room"
          fill
          priority
          sizes="50vw"
          className="object-cover transition-transform duration-700 hover:scale-105"
        />

        {/* Dark Overlay */}

        <div className="absolute inset-0 bg-black/50" />

        {/* Gradient Overlay */}

        <div className="absolute inset-0 bg-gradient-to-br from-blue-950/70 via-transparent to-slate-900/80" />

        {/* Decorative Blur */}

        <div className="absolute -top-24 -left-24 h-96 w-96 rounded-full bg-blue-500/20 blur-3xl" />

        <div className="absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-cyan-400/20 blur-3xl" />

        {/* Glass Card */}

        <div className="absolute bottom-12 left-12 z-10 max-w-lg rounded-3xl border border-white/20 bg-white/10 p-8 shadow-2xl backdrop-blur-xl">

          <span className="rounded-full bg-blue-600 px-4 py-1 text-sm font-medium text-white">
            Smart Workspace
          </span>

          <h2 className="mt-6 text-5xl font-bold leading-tight text-white">
            Smart Meeting Scheduler
          </h2>

          <p className="mt-6 text-lg leading-8 text-slate-200">
            Schedule meetings, reserve conference rooms,
            manage organizers, collaborate with your team,
            and simplify workplace scheduling from a single
            secure platform.
          </p>

          <div className="mt-10 grid grid-cols-3 gap-4">

            <div className="rounded-2xl bg-white/10 p-4 text-center backdrop-blur-md">
              <h3 className="text-3xl font-bold text-white">
                24/7
              </h3>

              <p className="mt-2 text-sm text-slate-300">
                Availability
              </p>
            </div>

            <div className="rounded-2xl bg-white/10 p-4 text-center backdrop-blur-md">
              <h3 className="text-3xl font-bold text-white">
                100+
              </h3>

              <p className="mt-2 text-sm text-slate-300">
                Meetings
              </p>
            </div>

            <div className="rounded-2xl bg-white/10 p-4 text-center backdrop-blur-md">
              <h3 className="text-3xl font-bold text-white">
                Secure
              </h3>

              <p className="mt-2 text-sm text-slate-300">
                Access
              </p>
            </div>

          </div>

        </div>

      </div>

            {/* Access Denied Alert Dialog */}

      <AlertDialog
        open={open}
        onOpenChange={setOpen}
      >
        <AlertDialogContent className="sm:max-w-md">

          <AlertDialogHeader>

            <AlertDialogTitle className="text-center text-red-600 text-2xl">
              Access Denied
            </AlertDialogTitle>

            <AlertDialogDescription className="pt-3 text-center text-base">
              You do not belong to this organization.
              <br />
              Please contact your administrator if you
              believe this is a mistake.
            </AlertDialogDescription>

          </AlertDialogHeader>

          <AlertDialogFooter>

            <AlertDialogAction
              className="w-full"
              onClick={() => {
                setOpen(false);

                window.history.replaceState(
                  {},
                  "",
                  "/login"
                );
              }}
            >
              OK
            </AlertDialogAction>

          </AlertDialogFooter>

        </AlertDialogContent>

      </AlertDialog>

        </div>
  );
}