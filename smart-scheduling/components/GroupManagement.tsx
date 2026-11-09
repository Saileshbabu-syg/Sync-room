"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Pagination from "@/components/Pagination";
import {
  AppBookingPolicyPanel,
  DEFAULT_GROUP_POLICY,
  bookingPolicySummary,
  GroupBookingPolicySection,
  groupPolicyFormProblem,
  type AppBookingSettingsView,
} from "@/components/BookingPolicyFields";
import type { GroupBookingPolicy, OvernightSetting } from "@/lib/booking-limits";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";

export type GroupRow = {
  id: number;
  name: string;
  description: string | null;
  priority: number;
  isActive: boolean;
  createdAt: string;
  employeeCount: number;
  permissions: string[];
  meetingTypeIds: number[];
  settings: {
    maxDurationMinutes: number | null;
    maxAdvanceDays: number | null;
    maxOccurrences: number | null;
    overnightPolicy: OvernightSetting;
    maxBookingsPerDay: number | null;
    maxBookingsPerWeek: number | null;
    maxBookingsPerMonth: number | null;
  };
  // Empty = every room.
  roomIds: number[];
};

export type RoomOption = { id: number; name: string };

type EntraSettings = {
  autoSyncEnabled: boolean;
  intervalHours: number;
  defaultGroupId: number | null;
};

export type MeetingTypeOption = { id: number; name: string; priorityRank: number };

type EmployeeRow = {
  employeeId: number;
  name: string;
  email: string;
  role: string;
  groupId: number | null;
  groupName: string | null;
  assignedAt: string | null;
};

type HistoryRow = {
  id: number;
  groupName: string;
  assignedAt: string;
  effectiveUntil: string | null;
  assignedBy: string | null;
};

type SyncRun = {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  error: string | null;
};

type SyncStatus = {
  configured: boolean;
  configProblem: string | null;
  running: boolean;
  last: SyncRun | null;
  lastSuccessAt: string | null;
};

type SyncSummary = {
  fetched: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  assignedToDefault: number;
  notInDirectory: number;
};

const PERMISSION_OPTIONS = [
  { key: "dashboard.view", label: "Dashboard" },
  { key: "group.manage", label: "Group Management" },
  { key: "booking.create", label: "Create bookings" },
  { key: "booking.view", label: "View bookings" },
  { key: "booking.cancel", label: "Cancel bookings" },
  { key: "booking.recurring", label: "Recurring meetings" },
  {
    key: "booking.outranks",
    label: "Outranks all meetings (a meeting that invites a member always gets the room)",
  },
  {
    key: "booking.protected",
    label: "Protected meetings (a meeting that invites a member can never be taken over)",
  },
  { key: "rooms.manage", label: "Room management (add, edit, delete rooms)" },
];

const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "-";

// The same 12-hour format, in the application timezone, as everywhere else.
const dateTime = (value: string | null) => formatDateTime(value);

async function api<T = unknown>(
  url: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message ?? "Something went wrong.");
  }

  return data as T;
}

/* ------------------------------ Groups tab -------------------------------- */

type FormState = {
  id: number | null;
  name: string;
  description: string;
  priority: string;
  isActive: boolean;
  permissions: string[];
  meetingTypeIds: number[];
  allRooms: boolean;
  roomIds: number[];
  // Booking policies (overnight, longest meeting, bookings per day/week/month)
  // and the values the form opened with, to tell what the admin changed.
  policy: GroupBookingPolicy;
  initialPolicy: GroupBookingPolicy;
};

// Groups no longer set days-ahead or series-length limits here; the API still
// takes them (empty). The booking policies are separate fields below.
const NO_LIMITS = { maxAdvanceDays: null, maxOccurrences: null };

const policyOf = (g: GroupRow): GroupBookingPolicy => ({
  overnight: g.settings.overnightPolicy,
  maxDurationMinutes: g.settings.maxDurationMinutes,
  maxBookingsPerDay: g.settings.maxBookingsPerDay,
  maxBookingsPerWeek: g.settings.maxBookingsPerWeek,
  maxBookingsPerMonth: g.settings.maxBookingsPerMonth,
});

// A dropdown of rooms with a checkbox each, so an admin can give a group some
// rooms and not others. "All rooms" (the default) also covers rooms added later;
// picking a particular room switches it off, ticking it again clears the rest.
function RoomPicker({
  rooms,
  allRooms,
  roomIds,
  onChange,
}: {
  rooms: RoomOption[];
  allRooms: boolean;
  roomIds: number[];
  onChange: (allRooms: boolean, roomIds: number[]) => void;
}) {
  const chosen = rooms.filter((r) => roomIds.includes(r.id));

  const summary = allRooms
    ? "All rooms (including rooms added later)"
    : chosen.length === 0
      ? "Choose rooms"
      : chosen.length <= 2
        ? chosen.map((r) => r.name).join(", ")
        : `${chosen.length} rooms selected`;

  return (
    <details className="group/rooms relative rounded-md border border-input bg-background shadow-xs">
      <summary
        className="flex h-9 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        data-testid="room-picker"
      >
        <span className={allRooms || chosen.length > 0 ? "" : "text-muted-foreground"}>
          {summary}
        </span>
        <span aria-hidden className="text-xs text-muted-foreground transition-transform group-open/rooms:rotate-180">
          ▾
        </span>
      </summary>

      <div className="max-h-56 space-y-2 overflow-y-auto border-t p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={allRooms}
            onCheckedChange={(checked) => onChange(checked === true, [])}
          />
          All rooms (including rooms added later)
        </label>

        {rooms.map((r) => (
          <label key={r.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={!allRooms && roomIds.includes(r.id)}
              onCheckedChange={(checked) =>
                onChange(
                  false,
                  checked === true
                    ? roomIds.includes(r.id)
                      ? roomIds
                      : [...roomIds, r.id]
                    : roomIds.filter((id) => id !== r.id)
                )
              }
            />
            {r.name}
          </label>
        ))}

        {rooms.length === 0 && <p className="text-xs text-gray-500">No rooms exist yet.</p>}
      </div>

      {!allRooms && roomIds.length === 0 && (
        <p className="border-t px-3 py-2 text-xs text-amber-700">
          Choose at least one room, or All rooms.
        </p>
      )}
    </details>
  );
}

function GroupsTab({
  groups,
  meetingTypes,
  rooms,
  reload,
  appSettings,
  onAppSettings,
}: {
  groups: GroupRow[];
  meetingTypes: MeetingTypeOption[];
  rooms: RoomOption[];
  reload: () => Promise<void>;
  // The booking policies, for people who may manage groups.
  appSettings: AppBookingSettingsView | null;
  onAppSettings: (settings: AppBookingSettingsView) => void;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<GroupRow | null>(null);
  const [confirmToggle, setConfirmToggle] = useState<GroupRow | null>(null);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setSaving(true);

    try {
      await action();
      toast.success(success);
      await reload();

      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed.");

      return false;
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!form) return;

    const payload = {
      name: form.name,
      description: form.description,
      priority: Number(form.priority),
      isActive: form.isActive,
      permissions: form.permissions,
      meetingTypeIds: form.meetingTypeIds,
      settings: {
        ...NO_LIMITS,
        // Everyone keeps the group's stored duration; only an administrator
        // (who sees the policy section) sends the new policy fields.
        maxDurationMinutes: form.policy.maxDurationMinutes,
        ...(appSettings && {
          overnightPolicy: form.policy.overnight,
          maxBookingsPerDay: form.policy.maxBookingsPerDay,
          maxBookingsPerWeek: form.policy.maxBookingsPerWeek,
          maxBookingsPerMonth: form.policy.maxBookingsPerMonth,
        }),
      },
      // An empty list means every room.
      roomIds: form.allRooms ? [] : form.roomIds,
    };

    if (!form.allRooms && form.roomIds.length === 0) {
      toast.error("Choose at least one room, or choose All rooms.");

      return;
    }

    const ok = await run(
      () =>
        form.id === null
          ? api("/api/admin/groups", "POST", payload)
          : api(`/api/admin/groups/${form.id}`, "PATCH", payload),
      form.id === null ? "Group created." : "Group updated."
    );

    if (ok) setForm(null);
  };

  const toggleIn = <T,>(list: T[], value: T, on: boolean) =>
    on ? (list.includes(value) ? list : [...list, value]) : list.filter((v) => v !== value);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          Each group has its own permissions and the meeting types it may book.
        </p>

        <Button
          onClick={() =>
            setForm({
              id: null,
              name: "",
              description: "",
              priority: "5",
              isActive: true,
              permissions: ["booking.create", "booking.view", "booking.cancel"],
              // A new group starts able to book every type; untick what it
              // must not use.
              meetingTypeIds: meetingTypes.map((t) => t.id),
              allRooms: true,
              roomIds: [],
              policy: DEFAULT_GROUP_POLICY,
              initialPolicy: DEFAULT_GROUP_POLICY,
            })
          }
          data-testid="add-group"
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Group
        </Button>
      </div>

      {appSettings && (
        <AppBookingPolicyPanel settings={appSettings} onSaved={onAppSettings} />
      )}

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Group</th>
              <th className="p-3">Description</th>
              {appSettings && <th className="p-3">Booking policies</th>}
              <th className="p-3">Employees</th>
              <th className="p-3">Status</th>
              <th className="p-3">Created</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>

          <tbody>
            {groups.map((g) => (
              <tr key={g.id} className="border-t hover:bg-slate-50">
                <td className="p-3 font-medium">{g.name}</td>
                <td
                  className="max-w-[260px] truncate p-3 text-gray-500"
                  title={g.description ?? ""}
                >
                  {g.description || "-"}
                </td>
                {appSettings && (
                  <td
                    className="max-w-[260px] p-3 text-xs text-gray-600"
                    data-testid={`group-policy-${g.id}`}
                  >
                    {bookingPolicySummary(appSettings, policyOf(g))}
                  </td>
                )}
                <td className="p-3" data-testid={`group-count-${g.id}`}>
                  {g.employeeCount}
                </td>
                <td className="p-3">
                  <Badge variant={g.isActive ? "default" : "destructive"}>
                    {g.isActive ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td className="p-3 text-gray-500">{date(g.createdAt)}</td>
                <td className="p-3">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${g.name}`}
                      onClick={() =>
                        setForm({
                          id: g.id,
                          name: g.name,
                          description: g.description ?? "",
                          priority: String(g.priority),
                          isActive: g.isActive,
                          permissions: g.permissions.filter((key) =>
                            PERMISSION_OPTIONS.some((o) => o.key === key)
                          ),
                          meetingTypeIds: g.meetingTypeIds,
                          allRooms: g.roomIds.length === 0,
                          roomIds: g.roomIds,
                          policy: policyOf(g),
                          initialPolicy: policyOf(g),
                        })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmToggle(g)}>
                      {g.isActive ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${g.name}`}
                      onClick={() => setConfirmDelete(g)}
                    >
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}

            {groups.length === 0 && (
              <tr>
                <td colSpan={7} className="p-10 text-center text-gray-500">
                  No groups yet. Use Add Group to create the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add / edit */}
      <Sheet open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{form?.id === null ? "Add group" : "Edit group"}</SheetTitle>
            <SheetDescription>
              Groups exist only in this application, not in your identity
              provider.
            </SheetDescription>
          </SheetHeader>

          {form && (
            <div className="space-y-4 px-4">
              <div className="space-y-2">
                <Label htmlFor="group-name">Group name</Label>
                <Input
                  id="group-name"
                  value={form.name}
                  maxLength={100}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="group-description">Description</Label>
                <Input
                  id="group-description"
                  value={form.description}
                  maxLength={500}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="group-priority">Group order (1 = first)</Label>
                <Input
                  id="group-priority"
                  type="number"
                  min={1}
                  max={1000}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                />
                <p className="text-xs text-gray-500">
                  Only decides which group wins when an employee is in several
                  mapped Entra groups. It does not affect room booking: that is
                  set by meeting type priority (see the Meeting types tab).
                </p>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Permissions</legend>

                {PERMISSION_OPTIONS.map((p) => (
                  <label key={p.key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.permissions.includes(p.key)}
                      onCheckedChange={(checked) =>
                        setForm({
                          ...form,
                          permissions: toggleIn(form.permissions, p.key, checked === true),
                        })
                      }
                    />
                    {p.label}
                  </label>
                ))}
              </fieldset>

              <fieldset className="space-y-2" data-testid="meeting-type-permissions">
                <legend className="text-sm font-medium">Meeting types this group can book</legend>

                {meetingTypes.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.meetingTypeIds.includes(t.id)}
                      onCheckedChange={(checked) =>
                        setForm({
                          ...form,
                          meetingTypeIds: toggleIn(form.meetingTypeIds, t.id, checked === true),
                        })
                      }
                    />
                    {t.name}
                  </label>
                ))}

                {form.meetingTypeIds.length === 0 && (
                  <p className="text-xs text-amber-700">
                    With none ticked, this group cannot book any meeting.
                  </p>
                )}
              </fieldset>

              <fieldset className="space-y-2" data-testid="room-access">
                <legend className="text-sm font-medium">Rooms this group can book</legend>

                <RoomPicker
                  rooms={rooms}
                  allRooms={form.allRooms}
                  roomIds={form.roomIds}
                  onChange={(allRooms, roomIds) => setForm({ ...form, allRooms, roomIds })}
                />
              </fieldset>

              {appSettings && (
                <GroupBookingPolicySection
                  app={appSettings}
                  value={form.policy}
                  initial={form.initialPolicy}
                  onChange={(policy) => setForm({ ...form, policy })}
                />
              )}

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.isActive}
                  onCheckedChange={(checked) =>
                    setForm({ ...form, isActive: checked === true })
                  }
                />
                Active (inactive groups cannot receive new employees)
              </label>
            </div>
          )}

          <SheetFooter>
            <Button
              disabled={
                saving ||
                !form?.name.trim() ||
                (appSettings !== null &&
                  form !== null &&
                  groupPolicyFormProblem(appSettings, form.policy, form.initialPolicy) !== null)
              }
              onClick={submit}
            >
              {saving ? "Saving..." : "Save group"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Confirm delete */}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent compact>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Only a group with no employees and no booking history can be
              deleted. Otherwise it is kept and you can deactivate it instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmDelete &&
                run(() => api(`/api/admin/groups/${confirmDelete.id}`, "DELETE"), "Group deleted.")
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm activate / deactivate */}
      <AlertDialog
        open={confirmToggle !== null}
        onOpenChange={(open) => !open && setConfirmToggle(null)}
      >
        <AlertDialogContent compact>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmToggle?.isActive ? "Deactivate" : "Activate"} {confirmToggle?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmToggle?.isActive
                ? "Members of an inactive group are treated as having no group (lowest priority, no preemption) until they are moved. No new employees can be added."
                : "The group can receive employees again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmToggle &&
                run(
                  () =>
                    api(`/api/admin/groups/${confirmToggle.id}`, "PATCH", {
                      isActive: !confirmToggle.isActive,
                    }),
                  "Group updated."
                )
              }
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------------ Entra sync -------------------------------- */

function EntraSync({ onSynced }: { onSynced: () => Promise<void> }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<SyncStatus>("/api/admin/employees/sync");

      setStatus(data);

      return data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();

    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [refresh]);

  const sync = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);

    // While the request is open, ask for progress every couple of seconds.
    poll.current = setInterval(() => void refresh(), 2000);

    try {
      const data = await api<{ summary: SyncSummary }>("/api/admin/employees/sync", "POST");

      setSummary(data.summary);
      toast.success("Employees synchronised.");
      await onSynced();
    } catch (err) {
      const message = err instanceof Error ? err.message : "The sync failed.";

      setError(message);
      toast.error(message);
    } finally {
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
      setRunning(false);
      await refresh();
    }
  };

  const live = status?.running || running;

  return (
    <div className="space-y-3 rounded-xl border bg-slate-50 p-4" data-testid="entra-sync">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Microsoft Entra ID</p>
          <p className="text-sm text-gray-500" data-testid="last-sync">
            {status?.lastSuccessAt
              ? `Last successful sync: ${dateTime(status.lastSuccessAt)}`
              : "No successful sync yet."}
          </p>
        </div>

        <Button
          onClick={() => void sync()}
          disabled={live || status?.configured === false}
          data-testid="sync-entra"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${live ? "animate-spin" : ""}`} />
          {live ? "Syncing..." : "Sync from Entra ID"}
        </Button>
      </div>

      {status?.configured === false && (
        <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {status.configProblem}
        </p>
      )}

      {live && (
        <p role="status" className="text-sm text-blue-700" data-testid="sync-progress">
          Synchronising
          {status?.last?.status === "RUNNING" && status.last.fetched > 0
            ? `: ${status.last.fetched} accounts read, ${status.last.created} added, ${status.last.linked} linked, ${status.last.updated} updated so far`
            : "..."}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {summary && !live && (
        <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800" data-testid="sync-summary">
          Done. {summary.fetched} accounts read: {summary.created} added, {summary.linked} linked to
          existing employees, {summary.updated} updated, {summary.skipped} skipped.{" "}
          {summary.assignedToDefault} placed in the Employee group.
          {summary.notInDirectory > 0
            ? ` ${summary.notInDirectory} synced employees are no longer in the directory (kept).`
            : ""}
        </p>
      )}

      {!live && !error && !summary && status?.last?.status === "FAILED" && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          The last sync ({dateTime(status.last.startedAt)}) failed
          {status.last.error ? `: ${status.last.error}` : "."}
        </p>
      )}
    </div>
  );
}

/* --------------------------- Entra sync settings --------------------------- */

const INTERVALS = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "1 day" },
  { hours: 168, label: "1 week" },
  { hours: 720, label: "1 month" },
];

// Saved as soon as it changes; the manual "Sync from Entra ID" button above
// works whether or not automatic sync is on.
function EntraSettingsPanel({ groups }: { groups: GroupRow[] }) {
  const [settings, setSettings] = useState<EntraSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ settings: EntraSettings }>("/api/admin/entra/settings")
      .then((data) => setSettings(data.settings))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not load the sync settings."));
  }, []);

  if (!settings) return null;

  const save = async (next: EntraSettings) => {
    const previous = settings;

    setSettings(next);
    setSaving(true);

    try {
      if (next.defaultGroupId === null) return;

      const data = await api<{ settings: EntraSettings }>("/api/admin/entra/settings", "PUT", next);

      setSettings(data.settings);
      toast.success("Sync settings saved.");
    } catch (err) {
      setSettings(previous);
      toast.error(err instanceof Error ? err.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-white p-4"
      data-testid="entra-settings"
    >
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={settings.autoSyncEnabled}
          disabled={saving}
          onCheckedChange={(checked) => void save({ ...settings, autoSyncEnabled: checked === true })}
        />
        Sync automatically
      </label>

      <div className="flex items-center gap-2 text-sm">
        <Label htmlFor="sync-default-group">New members join</Label>
        <select
          id="sync-default-group"
          className={selectClass}
          value={settings.defaultGroupId ?? ""}
          disabled={saving}
          onChange={(e) => void save({ ...settings, defaultGroupId: Number(e.target.value) })}
        >
          {settings.defaultGroupId === null && <option value="">Choose...</option>}
          {groups
            .filter((g) => g.isActive || g.id === settings.defaultGroupId)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Label htmlFor="sync-interval">Every</Label>
        <select
          id="sync-interval"
          className={selectClass}
          value={settings.intervalHours}
          disabled={!settings.autoSyncEnabled || saving}
          onChange={(e) => void save({ ...settings, intervalHours: Number(e.target.value) })}
        >
          {INTERVALS.map((i) => (
            <option key={i.hours} value={i.hours}>
              {i.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/* ----------------------------- Employees tab ------------------------------ */

function EmployeesTab({
  groups,
  reloadGroups,
}: {
  groups: GroupRow[];
  reloadGroups: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    employee: EmployeeRow;
    groupId: number | null;
  } | null>(null);
  const [history, setHistory] = useState<{
    employee: EmployeeRow;
    rows: HistoryRow[];
  } | null>(null);

  const pageSize = 15;

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);

    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });

      if (query) params.set("search", query);
      if (groupFilter) params.set("groupId", groupFilter);

      const data = await api<{ rows: EmployeeRow[]; total: number }>(
        `/api/admin/employees?${params}`
      );

      setRows(data.rows);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load employees.");
    } finally {
      setLoading(false);
    }
  }, [page, query, groupFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const apply = async () => {
    if (!pending) return;

    const { employee, groupId } = pending;

    try {
      if (groupId === null) {
        await api(`/api/admin/employees/${employee.employeeId}/group`, "DELETE");
      } else {
        await api(`/api/admin/employees/${employee.employeeId}/group`, "PUT", { groupId });
      }

      toast.success(`${employee.name} updated.`);
      await Promise.all([load(), reloadGroups()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed.");
    }
  };

  const showHistory = async (employee: EmployeeRow) => {
    try {
      const data = await api<{ history: HistoryRow[] }>(
        `/api/admin/employees/${employee.employeeId}/group`
      );

      setHistory({ employee, rows: data.history });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load history.");
    }
  };

  const target = pending ? groups.find((g) => g.id === pending.groupId) : undefined;

  return (
    <div className="space-y-4">
      <EntraSync onSynced={async () => { await Promise.all([load(), reloadGroups()]); }} />

      <EntraSettingsPanel groups={groups} />

      <div className="flex flex-wrap gap-3">
        <Input
          className="max-w-sm"
          placeholder="Search by name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search employees"
        />

        <select
          className={selectClass}
          value={groupFilter}
          onChange={(e) => {
            setGroupFilter(e.target.value);
            setPage(1);
          }}
          aria-label="Filter by group"
        >
          <option value="">All groups</option>
          <option value="none">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}{" "}
          <button className="underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Employee</th>
              <th className="p-3">Role</th>
              <th className="p-3">Group</th>
              <th className="p-3">Since</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>

          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="p-10 text-center text-gray-500">
                  Loading employees...
                </td>
              </tr>
            )}

            {!loading && rows.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="p-10 text-center text-gray-500">
                  No employees match your search.
                </td>
              </tr>
            )}

            {!loading &&
              rows.map((e) => (
                <tr key={e.employeeId} className="border-t hover:bg-slate-50">
                  <td className="p-3">
                    <div className="font-medium">{e.name}</div>
                    <div className="text-xs text-gray-500">{e.email}</div>
                  </td>
                  <td className="p-3 text-gray-600">{e.role}</td>
                  <td className="p-3">
                    <select
                      className={selectClass}
                      value={e.groupId ?? ""}
                      aria-label={`Group for ${e.name}`}
                      onChange={(ev) => {
                        const value = ev.target.value;

                        if (value) setPending({ employee: e, groupId: Number(value) });
                      }}
                    >
                      <option value="" disabled>
                        No group (default policy)
                      </option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id} disabled={!g.isActive && g.id !== e.groupId}>
                          {g.name}
                          {g.isActive ? "" : " - inactive"}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="p-3 text-gray-500">{date(e.assignedAt)}</td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`History for ${e.name}`}
                        onClick={() => void showHistory(e)}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      {e.groupId !== null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPending({ employee: e, groupId: null })}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pages={Math.max(1, Math.ceil(total / pageSize))}
        onPage={setPage}
        noun="employee"
        total={total}
      />

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent compact>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.groupId === null
                ? `Remove ${pending.employee.name} from their group?`
                : `Move ${pending?.employee.name} to ${target?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.groupId === null
                ? "They fall back to the default policy: lowest priority and no preemption."
                : "Future bookings use the new group's priority. Past bookings are not changed, and the previous assignment stays in the history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void apply()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={history !== null} onOpenChange={(open) => !open && setHistory(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{history?.employee.name}</SheetTitle>
            <SheetDescription>{history?.employee.email}</SheetDescription>
          </SheetHeader>

          <ul className="space-y-3 px-4 text-sm">
            {history?.rows.length === 0 && (
              <li className="text-gray-500">No group has ever been assigned.</li>
            )}
            {history?.rows.map((h) => (
              <li key={h.id} className="rounded-lg border p-3">
                <div className="font-medium">
                  {h.groupName}
                  {!h.effectiveUntil && <Badge className="ml-2">Current</Badge>}
                </div>
                <div className="text-xs text-gray-500">
                  {date(h.assignedAt)} to {h.effectiveUntil ? date(h.effectiveUntil) : "now"}
                  {h.assignedBy ? ` - by ${h.assignedBy}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ---------------------------- Meeting types tab --------------------------- */

// How meeting types rank when two bookings want the same room. A smaller number
// wins; equal numbers are first-come-first-served. Saved per row.
function MeetingTypesTab({
  types,
  onSaved,
}: {
  types: MeetingTypeOption[];
  onSaved: (type: MeetingTypeOption) => void;
}) {
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);

  const valueOf = (t: MeetingTypeOption) => draft[t.id] ?? String(t.priorityRank);

  const save = async (t: MeetingTypeOption) => {
    setSavingId(t.id);

    try {
      const data = await api<{ meetingType: { id: number; name: string; priorityRank: number } }>(
        `/api/admin/meeting-types/${t.id}`,
        "PATCH",
        { priorityRank: Number(valueOf(t)) }
      );

      onSaved({ ...t, priorityRank: data.meetingType.priorityRank });
      setDraft((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => Number(id) !== t.id))
      );
      toast.success(`${t.name} priority saved.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="meeting-type-priorities">
      <p className="text-sm text-gray-500">
        When two meetings want the same room, the one whose type has the smaller
        number gets it (1 is the highest, 5 the lowest). Equal numbers: whoever
        booked first keeps the room. A change applies at once, to meetings
        already booked as well as new ones. A meeting with a member of a group
        that has the Outranks or Protected permission is handled separately.
      </p>

      <div className="divide-y rounded-lg border bg-white">
        {types.map((t) => {
          const changed = valueOf(t) !== String(t.priorityRank);

          return (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <span className="font-medium">{t.name}</span>

              <div className="flex items-center gap-2">
                <Label htmlFor={`type-rank-${t.id}`} className="text-sm text-gray-500">
                  Priority
                </Label>
                <select
                  id={`type-rank-${t.id}`}
                  className={selectClass}
                  value={valueOf(t)}
                  onChange={(e) => setDraft({ ...draft, [t.id]: e.target.value })}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                      {n === 1 ? " (highest)" : n === 5 ? " (lowest)" : ""}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={!changed || savingId === t.id}
                  onClick={() => save(t)}
                >
                  {savingId === t.id ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------- Page ----------------------------------- */

export default function GroupManagement({
  initialGroups,
  meetingTypes,
  rooms,
  initialAppSettings = null,
}: {
  initialGroups: GroupRow[];
  meetingTypes: MeetingTypeOption[];
  rooms: RoomOption[];
  // The application booking policies, for people who may manage groups.
  initialAppSettings?: AppBookingSettingsView | null;
}) {
  const [appSettings, setAppSettings] = useState(initialAppSettings);
  const [groups, setGroups] = useState(initialGroups);
  const [types, setTypes] = useState(meetingTypes);

  const reload = useCallback(async () => {
    try {
      const data = await api<{ groups: GroupRow[] }>("/api/admin/groups");

      setGroups(data.groups);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not refresh groups.");
    }
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Group Management</h1>
        <p className="mt-2 text-gray-500">
          Manage groups, their permissions, the meeting types and rooms they can
          book, who belongs to each group, and how meeting types rank for rooms.
        </p>
      </div>

      <Tabs
        defaultValue="groups"
        // The member counts come from the database: refresh them whenever the
        // Groups tab is opened, so they are never stale.
        onValueChange={(value) => {
          if (value === "groups") void reload();
        }}
      >
        <TabsList>
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="employees">Employees</TabsTrigger>
          <TabsTrigger value="meeting-types">Meeting types</TabsTrigger>
        </TabsList>

        <TabsContent value="groups" className="pt-4">
          <GroupsTab
            groups={groups}
            meetingTypes={types}
            rooms={rooms}
            reload={reload}
            appSettings={appSettings}
            onAppSettings={(next) => {
              setAppSettings(next);
              void reload();
            }}
          />
        </TabsContent>

        <TabsContent value="employees" className="pt-4">
          <EmployeesTab groups={groups} reloadGroups={reload} />
        </TabsContent>

        <TabsContent value="meeting-types" className="pt-4">
          <MeetingTypesTab
            types={types}
            onSaved={(saved) =>
              setTypes((current) => current.map((t) => (t.id === saved.id ? saved : t)))
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
