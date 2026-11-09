"use client";

import { useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDuration } from "@/lib/format";
import {
  groupPolicyProblem,
  resolveEffectivePolicy,
  type AppBookingPolicy,
  type GroupBookingPolicy,
  type OvernightSetting,
} from "@/lib/booking-limits";

// Admin controls for the booking policies (lib/booking-limits.ts explains how
// the application's and a group's values combine: the stricter one applies).

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

export type AppBookingSettingsView = AppBookingPolicy & {
  // Groups whose own stored values are looser than the application's now.
  groupsAboveLimits: string[];
};

const hoursText = formatDuration;

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(data.message ?? "Something went wrong.");

  return data as T;
}

/* ------------------------------ shared fields ------------------------------ */

// A whole-number limit with an "unlimited" switch. `ceiling` is the application's
// limit: a group's "unlimited" means "use the application's".
function CountLimitField({
  label,
  help,
  value,
  onChange,
  ceiling = null,
  min = 1,
  max,
}: {
  label: string;
  help: string;
  value: number | null;
  onChange: (value: number | null) => void;
  ceiling?: number | null;
  min?: number;
  max: number;
}) {
  const id = useId();
  const limited = value !== null;
  const unlimitedLabel =
    ceiling === null ? "Unlimited" : `No limit of its own (use the application's ${ceiling})`;
  const tooHigh = limited && ceiling !== null && value > ceiling;
  const invalid = limited && (!Number.isInteger(value) || value < min || value > max);

  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-n`}>{label}</Label>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          id={`${id}-n`}
          type="number"
          inputMode="numeric"
          min={min}
          max={ceiling ?? max}
          className="w-28"
          disabled={!limited}
          value={limited ? value : ""}
          aria-invalid={tooHigh || invalid}
          aria-describedby={`${id}-help`}
          onChange={(e) => onChange(e.target.value === "" ? min : Number(e.target.value))}
        />

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={!limited}
            onCheckedChange={(checked) =>
              onChange(checked === true ? null : ceiling !== null ? Math.min(ceiling, 3) : 3)
            }
          />
          {unlimitedLabel}
        </label>
      </div>

      <p id={`${id}-help`} className="text-xs text-gray-500">
        {help}
      </p>

      {tooHigh && (
        <p className="text-xs text-red-600" role="alert">
          Cannot be more than the application limit of {ceiling}.
        </p>
      )}

      {!tooHigh && invalid && (
        <p className="text-xs text-red-600" role="alert">
          Enter a whole number from {min} to {max}.
        </p>
      )}
    </div>
  );
}

// A duration in minutes, edited as hours and minutes, with an "unlimited"
// switch. Under a finite application maximum a group has no "unlimited": it
// uses the application's maximum.
function DurationField({
  label,
  help,
  value,
  onChange,
  ceiling = null,
}: {
  label: string;
  help: string;
  value: number | null;
  onChange: (value: number | null) => void;
  ceiling?: number | null;
}) {
  const id = useId();
  const limited = value !== null;
  const hours = limited ? Math.floor(value / 60) : 0;
  const minutes = limited ? value % 60 : 0;
  const tooShort = limited && value < 15;
  const tooLong = limited && value > 1440;
  const tooHigh = limited && ceiling !== null && value > ceiling;

  const set = (h: number, m: number) => onChange(Math.max(0, h) * 60 + Math.max(0, m));

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label={`${label}: hours`}
            type="number"
            inputMode="numeric"
            min={0}
            max={24}
            className="w-20"
            disabled={!limited}
            value={limited ? hours : ""}
            aria-invalid={tooShort || tooLong || tooHigh}
            aria-describedby={`${id}-help`}
            onChange={(e) => set(Number(e.target.value) || 0, minutes)}
          />
          <span className="text-sm text-gray-600">h</span>

          <Input
            aria-label={`${label}: minutes`}
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={5}
            className="w-20"
            disabled={!limited}
            value={limited ? minutes : ""}
            aria-invalid={tooShort || tooLong || tooHigh}
            aria-describedby={`${id}-help`}
            onChange={(e) => set(hours, Math.min(59, Number(e.target.value) || 0))}
          />
          <span className="text-sm text-gray-600">min</span>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={!limited}
            onCheckedChange={(checked) =>
              onChange(checked === true ? null : (ceiling ?? 120))
            }
          />
          {ceiling === null
            ? "Unlimited"
            : `No limit of its own (use the application's ${hoursText(ceiling)})`}
        </label>
      </div>

      <p id={`${id}-help`} className="text-xs text-gray-500">
        {help}
      </p>

      {limited && (
        <p className="text-xs text-gray-600">= {value === 0 ? "0 minutes" : hoursText(value)}</p>
      )}

      {(tooShort || tooLong) && (
        <p className="text-xs text-red-600" role="alert">
          A meeting can last from 15 minutes to 24 hours.
        </p>
      )}

      {tooHigh && (
        <p className="text-xs text-red-600" role="alert">
          Cannot be more than the application maximum of {hoursText(ceiling!)}.
        </p>
      )}
    </fieldset>
  );
}

/* ------------------------- application-wide settings ------------------------ */

export function AppBookingPolicyPanel({
  settings,
  onSaved,
}: {
  settings: AppBookingSettingsView;
  onSaved: (settings: AppBookingSettingsView) => void;
}) {
  const [draft, setDraft] = useState<AppBookingPolicy>({
    allowOvernight: settings.allowOvernight,
    maxDurationMinutes: settings.maxDurationMinutes,
    maxBookingsPerDay: settings.maxBookingsPerDay,
    maxBookingsPerWeek: settings.maxBookingsPerWeek,
    maxBookingsPerMonth: settings.maxBookingsPerMonth,
  });
  const [saving, setSaving] = useState(false);

  const stored: AppBookingPolicy = {
    allowOvernight: settings.allowOvernight,
    maxDurationMinutes: settings.maxDurationMinutes,
    maxBookingsPerDay: settings.maxBookingsPerDay,
    maxBookingsPerWeek: settings.maxBookingsPerWeek,
    maxBookingsPerMonth: settings.maxBookingsPerMonth,
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  const duration = draft.maxDurationMinutes;
  const invalid =
    (duration !== null && (duration < 15 || duration > 1440)) ||
    [draft.maxBookingsPerDay, draft.maxBookingsPerWeek, draft.maxBookingsPerMonth].some(
      (v) => v !== null && (!Number.isInteger(v) || v < 1)
    );

  const save = async () => {
    setSaving(true);

    try {
      const data = await request<{ settings: AppBookingSettingsView }>(
        "/api/admin/booking-settings",
        "PUT",
        draft
      );

      onSaved(data.settings);
      toast.success("Application booking policies saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the booking policies.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="rounded-xl border bg-white" data-testid="app-booking-policies">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <span>
          <span className="block font-medium">Application booking policies</span>
          <span className="block text-sm text-gray-500">
            Upper limits for every group: overnight meetings, longest meeting and bookings per day,
            week and month.
          </span>
        </span>
        <span aria-hidden className="text-xs text-muted-foreground">▾</span>
      </summary>

      <div className="space-y-5 border-t p-4">
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={draft.allowOvernight}
            onCheckedChange={(checked) => setDraft({ ...draft, allowOvernight: checked === true })}
          />
          <span>
            <span className="font-medium">Allow overnight bookings</span>
            <span className="block text-xs text-gray-500">
              The master switch: when it is off, no group can book a meeting that continues past
              midnight (for example 11:00 PM to 01:00 AM). When it is on, each group can still opt
              out. The meeting counts against the day it starts, and it must still fit the longest
              meeting and the booking limits.
            </span>
          </span>
        </label>

        <DurationField
          label="Maximum meeting duration"
          help="The longest meeting anywhere in the application. A group can set a shorter one, never a longer one."
          value={draft.maxDurationMinutes}
          onChange={(v) => setDraft({ ...draft, maxDurationMinutes: v })}
        />

        <div className="grid gap-5 sm:grid-cols-3">
          <CountLimitField
            label="Maximum bookings per day"
            help="Per group, per calendar day."
            value={draft.maxBookingsPerDay}
            max={1000}
            onChange={(v) => setDraft({ ...draft, maxBookingsPerDay: v })}
          />
          <CountLimitField
            label="Maximum bookings per week"
            help="Per group, Monday to Sunday."
            value={draft.maxBookingsPerWeek}
            max={5000}
            onChange={(v) => setDraft({ ...draft, maxBookingsPerWeek: v })}
          />
          <CountLimitField
            label="Maximum bookings per month"
            help="Per group, per calendar month."
            value={draft.maxBookingsPerMonth}
            max={20000}
            onChange={(v) => setDraft({ ...draft, maxBookingsPerMonth: v })}
          />
        </div>

        <p className="text-xs text-gray-500">
          A booking counts for its group (all members together) on the day it starts. Cancelled
          meetings are not counted. Changing a policy never cancels or edits an existing meeting;
          it applies to new bookings and reschedules.
        </p>

        {settings.groupsAboveLimits.length > 0 && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900" role="status">
            These groups have their own values looser than the application&apos;s. They were not
            changed; the stricter value applies to them: {settings.groupsAboveLimits.join(", ")}.
          </p>
        )}

        <Button disabled={saving || !dirty || invalid} onClick={save}>
          {saving ? "Saving..." : "Save booking policies"}
        </Button>
      </div>
    </details>
  );
}

/* ------------------------------ group settings ------------------------------ */

export const DEFAULT_GROUP_POLICY: GroupBookingPolicy = {
  overnight: "INHERIT",
  maxDurationMinutes: null,
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null,
  maxBookingsPerMonth: null,
};

// The problem to show for the fields the admin CHANGED (a value the application
// lowered later is not an error until it is edited).
export function groupPolicyFormProblem(
  app: AppBookingPolicy,
  value: GroupBookingPolicy,
  initial: GroupBookingPolicy
): string | null {
  return groupPolicyProblem(app, {
    overnight: value.overnight !== initial.overnight ? value.overnight : "INHERIT",
    maxDurationMinutes:
      value.maxDurationMinutes !== initial.maxDurationMinutes ? value.maxDurationMinutes : null,
    maxBookingsPerDay:
      value.maxBookingsPerDay !== initial.maxBookingsPerDay ? value.maxBookingsPerDay : null,
    maxBookingsPerWeek:
      value.maxBookingsPerWeek !== initial.maxBookingsPerWeek ? value.maxBookingsPerWeek : null,
    maxBookingsPerMonth:
      value.maxBookingsPerMonth !== initial.maxBookingsPerMonth ? value.maxBookingsPerMonth : null,
  });
}

// One line describing what is in force for a group: its own values combined with
// the application's (the stricter wins).
export function bookingPolicySummary(app: AppBookingPolicy, value: GroupBookingPolicy): string {
  const effective = resolveEffectivePolicy(app, value);

  return [
    effective.allowOvernight ? "overnight allowed" : "same-day only",
    effective.maxDuration.value === null
      ? "no duration limit"
      : `up to ${hoursText(effective.maxDuration.value)}`,
    ...(
      [
        ["day", "daily", effective.perDay],
        ["week", "weekly", effective.perWeek],
        ["month", "monthly", effective.perMonth],
      ] as const
    ).map(([period, adjective, limit]) =>
      limit.value === null ? `no ${adjective} limit` : `${limit.value} per ${period}`
    ),
  ].join(" · ");
}

export function GroupBookingPolicySection({
  app,
  value,
  initial,
  onChange,
}: {
  app: AppBookingPolicy;
  value: GroupBookingPolicy;
  initial: GroupBookingPolicy;
  onChange: (value: GroupBookingPolicy) => void;
}) {
  const problem = groupPolicyFormProblem(app, value, initial);
  const summary = bookingPolicySummary(app, value);

  return (
    <details open className="rounded-md border" data-testid="group-booking-policies">
      <summary className="cursor-pointer list-none p-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Booking policies
        <span className="block text-xs font-normal text-gray-500">{summary}</span>
      </summary>

      <div className="space-y-5 border-t p-3">
        <div className="space-y-2">
          <Label htmlFor="group-overnight">Overnight booking</Label>
          <select
            id="group-overnight"
            className={selectClass}
            value={value.overnight}
            onChange={(e) => onChange({ ...value, overnight: e.target.value as OvernightSetting })}
          >
            <option value="INHERIT">Inherit application setting</option>
            <option value="ALLOWED" disabled={!app.allowOvernight}>
              Allowed
            </option>
            <option value="NOT_ALLOWED">Not allowed</option>
          </select>
          <p className="text-xs text-gray-500">
            {app.allowOvernight
              ? "Whether this group's meetings may continue past midnight. A meeting counts against the day it starts."
              : "Overnight bookings are turned off for the whole application, so this group cannot allow them."}
          </p>
        </div>

        <DurationField
          label="Maximum meeting duration"
          help="The longest meeting this group can book."
          value={value.maxDurationMinutes}
          ceiling={app.maxDurationMinutes}
          onChange={(v) => onChange({ ...value, maxDurationMinutes: v })}
        />

        <CountLimitField
          label="Maximum bookings per day"
          help="All members of the group together, per calendar day."
          value={value.maxBookingsPerDay}
          ceiling={app.maxBookingsPerDay}
          max={1000}
          onChange={(v) => onChange({ ...value, maxBookingsPerDay: v })}
        />
        <CountLimitField
          label="Maximum bookings per week"
          help="All members together, Monday to Sunday."
          value={value.maxBookingsPerWeek}
          ceiling={app.maxBookingsPerWeek}
          max={5000}
          onChange={(v) => onChange({ ...value, maxBookingsPerWeek: v })}
        />
        <CountLimitField
          label="Maximum bookings per month"
          help="All members together, per calendar month."
          value={value.maxBookingsPerMonth}
          ceiling={app.maxBookingsPerMonth}
          max={20000}
          onChange={(v) => onChange({ ...value, maxBookingsPerMonth: v })}
        />

        {problem && (
          <p className="text-xs text-red-600" role="alert">
            {problem}
          </p>
        )}
      </div>
    </details>
  );
}
