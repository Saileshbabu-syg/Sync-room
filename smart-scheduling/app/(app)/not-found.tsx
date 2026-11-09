import Link from "next/link";

import { Button } from "@/components/ui/button";

// notFound() from a signed-in page; shown inside the header and sidebar.
export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-12 text-center">
      <h1 className="text-2xl font-bold">Not found</h1>

      <p className="mt-2 text-gray-500">
        What you are looking for does not exist or is no longer available.
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button asChild>
          <Link href="/home">Go to Home</Link>
        </Button>

        <Button variant="outline" asChild>
          <Link href="/rooms">Browse rooms</Link>
        </Button>
      </div>
    </div>
  );
}
