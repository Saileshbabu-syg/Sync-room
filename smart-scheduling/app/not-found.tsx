import Link from "next/link";

import { Button } from "@/components/ui/button";

// A URL that matches no page at all.
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center bg-slate-100 px-4 py-16">
      <div className="max-w-md rounded-3xl bg-white p-8 text-center shadow-sm">
        <p className="text-sm font-semibold text-blue-700">404</p>

        <h1 className="mt-2 text-2xl font-bold">Page not found</h1>

        <p className="mt-2 text-gray-500">
          The address may be mistyped, or the page has moved.
        </p>

        <Button className="mt-6" asChild>
          <Link href="/home">Go to Home</Link>
        </Button>
      </div>
    </main>
  );
}
