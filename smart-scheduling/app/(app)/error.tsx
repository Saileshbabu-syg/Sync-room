"use client";

import { useEffect } from "react";

import ErrorState from "@/components/ErrorState";

// Any signed-in page that fails to render. The header and sidebar (the layout)
// stay, so the user can navigate away or retry just this page.
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <ErrorState error={error} retry={retry} />;
}
