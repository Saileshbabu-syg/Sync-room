"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  title?: string;
  message?: string;
  // The thrown value from an error boundary. Its message is never shown: an
  // error from the server carries only a digest, which matches the server log.
  error?: unknown;
  retry?: () => void;
};

// What every error boundary shows: a plain explanation, a way to try again and
// a way out. No stack traces, SQL or internal messages reach the page.
export default function ErrorState({
  title = "Something went wrong",
  message = "This page could not be loaded. Please try again.",
  error,
  retry,
}: Props) {
  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;

  return (
    <div className="mx-auto max-w-xl px-4 py-12 text-center" role="alert">
      <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" aria-hidden />

      <h1 className="mt-4 text-2xl font-bold">{title}</h1>

      <p className="mt-2 text-gray-500">{message}</p>

      {digest && (
        <p className="mt-2 text-xs text-gray-400">
          Reference: <span className="font-mono">{digest}</span>
        </p>
      )}

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {retry && <Button onClick={() => retry()}>Try again</Button>}

        <Button variant="outline" asChild>
          <Link href="/home">Go to Home</Link>
        </Button>
      </div>
    </div>
  );
}
