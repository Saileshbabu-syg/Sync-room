"use client";

export type SeriesScope = "single" | "following" | "series";

const OPTIONS: { value: SeriesScope; label: string }[] = [
  { value: "single", label: "This occurrence only" },
  { value: "following", label: "This and following occurrences" },
  { value: "series", label: "Entire series" },
];

// For an occurrence of a recurring series: which occurrences a change or a
// cancellation is for. Past and completed occurrences are never changed.
export default function SeriesScopeSelect({
  value,
  onChange,
  name = "series-scope",
}: {
  value: SeriesScope;
  onChange: (scope: SeriesScope) => void;
  name?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">
        This meeting is part of a recurring series. Apply to:
      </legend>

      {OPTIONS.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
