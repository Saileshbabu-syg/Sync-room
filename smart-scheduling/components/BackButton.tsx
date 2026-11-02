"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  // A fixed parent page. Without it the button goes back in the browser history.
  href?: string;
};

export default function BackButton({ href }: Props) {
  const router = useRouter();

  if (href) {
    return (
      <Button variant="outline" asChild>
        <Link href={href} data-testid="back-button">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Link>
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      onClick={() => router.back()}
      data-testid="back-button"
    >
      <ArrowLeft className="mr-2 h-4 w-4" />
      Back
    </Button>
  );
}
