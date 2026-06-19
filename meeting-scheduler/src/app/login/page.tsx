"use client";
import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
<button
  onClick={() => signIn("google")}
  className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
>
  Sign in with Google
</button>
  );
}