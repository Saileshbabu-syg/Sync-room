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
  /**
   * With `after`: also offer times earlier than it, as the NEXT day (an overnight
   * meeting). Only set when the person's policy allows overnight bookings.
   */
  overnight?: boolean;
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
  overnight = false,
}: Props) {
  const current = value ? value.slice(0, 5) : "";
  const floor = after?.slice(0, 5);

  let options = floor
    ? [
        ...TIME_OPTIONS.filter((t) => t > floor),
        // The start itself would be a 24-hour meeting: never offered.
        ...(overnight ? TIME_OPTIONS.filter((t) => t < floor) : []),
      ]
    : TIME_OPTIONS;

  if (current && !options.includes(current)) {
    options = [...options, current].sort();
  }

  const label = (t: string) =>
    floor && t < floor ? `${formatTime(t)} (next day)` : formatTime(t);

  return (
    <Select value={current || undefined} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-64">
        {options.map((t) => (
          <SelectItem key={t} value={t}>
            {label(t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
