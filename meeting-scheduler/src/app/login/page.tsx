"use client";

import Image from "next/image";
import Link from "next/link";
import { signIn } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left Section */}
      <div className="flex items-center justify-center bg-white p-8">
        <div className="w-full max-w-md space-y-6">

          {/* Logo */}
          <div>
            <h1 className="text-3xl font-bold text-blue-700">
              MeetSched
            </h1>

            <h2 className="mt-8 text-4xl font-bold">
              Welcome Back
            </h2>

            <p className="mt-2 text-muted-foreground">
              Sign in to your account
            </p>
          </div>

          {/* Login Form */}
          <form className="space-y-4">

            <Input
              type="email"
              placeholder="Enter your email"
            />

            <Input
              type="password"
              placeholder="Enter your password"
            />

            <Button
              className="w-full bg-blue-700 hover:bg-blue-800"
            >
              Sign In
            </Button>

            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => signIn("google")}
            >
              Sign up with Google
            </Button>
          </form>

          {/* Signup Link */}
          <p className="text-center text-sm text-muted-foreground">
            Dont have an account?{" "}
            <Link
              href="/signup"
              className="font-medium text-blue-700 hover:underline"
            >
              Sign Up
            </Link>
          </p>

        </div>
      </div>

      {/* Right Section */}
      <div className="hidden lg:block relative">
        <Image
          src="/images/login-room.png"
          alt="Meeting Room"
          fill
          className="object-cover"
          priority
        />
      </div>
    </div>
  );
}