"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  // "booking" -> "12 bookings"
  noun: string;
  total: number;
};

// Previous / Next. A button that can be used is bold, dark and clearly a
// button; one that cannot is faded, not bold and not clickable, so the two
// states are never confused.
export default function Pagination({ page, pages, onPage, noun, total }: Props) {
  const canPrevious = page > 1;
  const canNext = page < pages;

  const enabled =
    "border-slate-900 bg-slate-900 font-bold text-white shadow-sm hover:bg-slate-700 hover:text-white";
  const disabled = "cursor-not-allowed font-normal opacity-40";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
      <span>
        {total} {noun}
        {total === 1 ? "" : "s"}
      </span>

      <nav className="flex items-center gap-3" aria-label="Pagination">
        <Button
          variant="outline"
          size="sm"
          disabled={!canPrevious}
          aria-disabled={!canPrevious}
          onClick={() => onPage(page - 1)}
          className={canPrevious ? enabled : disabled}
          data-testid="page-previous"
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>

        <span className="font-medium text-gray-700" aria-live="polite">
          Page {page} of {pages}
        </span>

        <Button
          variant="outline"
          size="sm"
          disabled={!canNext}
          aria-disabled={!canNext}
          onClick={() => onPage(page + 1)}
          className={canNext ? enabled : disabled}
          data-testid="page-next"
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>
    </div>
  );
}
