"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatTime } from "@/lib/format";

const INTERVAL_MINUTES = 30;

const TIME_OPTIONS: string[] = Array.from(
  { length: (24 * 60) / INTERVAL_MINUTES },
  (_, i) => {
    const total = i * INTERVAL_MINUTES;
    const h = String(Math.floor(total / 60)).padStart(2, "0");
    const m = String(total % 60).padStart(2, "0");
    return `${h}:${m}`;
  }
);

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Options at or before this "HH:mm" are hidden (e.g. end time vs start time). */
  after?: string;
};

// Picks a time on a 30-minute grid, shown as 12-hour "02:30 PM" labels. The
// value it holds and reports is still the 24-hour "HH:mm" the API expects, so
// ordering and validation are unchanged. A restored value that is off the grid
// (e.g. "09:15" from a saved draft) is kept as an extra option so it still shows.
export default function TimeSelect({
  value,
  onChange,
  placeholder = "Select time",
  after,
}: Props) {
  const current = value ? value.slice(0, 5) : "";

  let options = after
    ? TIME_OPTIONS.filter((t) => t > after.slice(0, 5))
    : TIME_OPTIONS;

  if (current && !options.includes(current)) {
    options = [...options, current].sort();
  }

  return (
    <Select value={current || undefined} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-64">
        {options.map((t) => (
          <SelectItem key={t} value={t}>
            {formatTime(t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
