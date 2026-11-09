"use client";

import { useEffect } from "react";

import "./globals.css";

// Replaces the root layout when that layout itself fails, so it brings its own
// <html>, <body> and styles. Kept free of app components that could fail too.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-slate-100 p-4 font-sans">
        <title>Something went wrong</title>

        <main role="alert" className="max-w-md rounded-3xl bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold">Something went wrong</h1>

          <p className="mt-2 text-gray-500">The application could not be loaded. Please try again.</p>

          {digest && <p className="mt-2 text-xs text-gray-400">Reference: {digest}</p>}

          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => retry()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Try again
            </button>

            {/* A full page load: the client router may be what failed. */}
            <a href="/home" className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-slate-50">
              Go to Home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
