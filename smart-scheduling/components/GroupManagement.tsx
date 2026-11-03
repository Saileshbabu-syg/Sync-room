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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  };
  // Empty = every room.
  roomIds: number[];
};

export type RoomOption = { id: number; name: string };

type EntraSettings = {
  autoSyncEnabled: boolean;
  intervalHours: number;
  mappings: {
    entraGroupId: string;
    entraGroupName: string;
    groupId: number;
    groupName: string;
  }[];
};

export type MeetingTypeOption = { id: number; name: string };

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
  mappedToGroup: number;
  assignedToDefault: number;
  notInDirectory: number;
};

const PERMISSION_OPTIONS = [
  { key: "dashboard.view", label: "Dashboard" },
  { key: "group.manage", label: "Group Management" },
  { key: "booking.create", label: "Create bookings" },
  { key: "booking.view", label: "View bookings" },
  { key: "booking.cancel", label: "Cancel bookings" },
  { key: "booking.priority", label: "Booking priority (may preempt)" },
  { key: "booking.recurring", label: "Recurring meetings" },
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

const dateTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

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
  // Blank = no extra limit.
  maxDuration: string;
  maxAdvance: string;
  maxOccurrences: string;
  allRooms: boolean;
  roomIds: number[];
};

const limitValue = (text: string) => (text.trim() === "" ? null : Number(text));

function GroupsTab({
  groups,
  meetingTypes,
  rooms,
  reload,
}: {
  groups: GroupRow[];
  meetingTypes: MeetingTypeOption[];
  rooms: RoomOption[];
  reload: () => Promise<void>;
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
        maxDurationMinutes: limitValue(form.maxDuration),
        maxAdvanceDays: limitValue(form.maxAdvance),
        maxOccurrences: limitValue(form.maxOccurrences),
      },
      // An empty list means every room.
      roomIds: form.allRooms ? [] : form.roomIds,
    };

    if (!form.allRooms && form.roomIds.length === 0) {
      toast.error("Tick at least one room, or choose All rooms.");

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
              permissions: ["booking.create", "booking.view", "booking.cancel", "booking.priority"],
              // A new group starts able to book every type; untick what it
              // must not use.
              meetingTypeIds: meetingTypes.map((t) => t.id),
              maxDuration: "",
              maxAdvance: "",
              maxOccurrences: "",
              allRooms: true,
              roomIds: [],
            })
          }
          data-testid="add-group"
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Group
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="p-3">Group</th>
              <th className="p-3">Description</th>
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
                          permissions: g.permissions,
                          meetingTypeIds: g.meetingTypeIds,
                          maxDuration: g.settings.maxDurationMinutes?.toString() ?? "",
                          maxAdvance: g.settings.maxAdvanceDays?.toString() ?? "",
                          maxOccurrences: g.settings.maxOccurrences?.toString() ?? "",
                          allRooms: g.roomIds.length === 0,
                          roomIds: g.roomIds,
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
                <td colSpan={6} className="p-10 text-center text-gray-500">
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
                <Label htmlFor="group-priority">Booking priority (1 = highest)</Label>
                <Input
                  id="group-priority"
                  type="number"
                  min={1}
                  max={1000}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                />
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

              <fieldset className="space-y-3" data-testid="booking-limits">
                <legend className="text-sm font-medium">Booking limits</legend>
                <p className="text-xs text-gray-500">
                  Leave a box empty for no extra limit. These can only be stricter than the system limits.
                </p>

                <div className="space-y-1">
                  <Label htmlFor="limit-duration">Longest meeting (minutes)</Label>
                  <Input
                    id="limit-duration"
                    type="number"
                    min={15}
                    max={1440}
                    placeholder="No limit"
                    value={form.maxDuration}
                    onChange={(e) => setForm({ ...form, maxDuration: e.target.value })}
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="limit-advance">Book at most this many days ahead (1 to 92)</Label>
                  <Input
                    id="limit-advance"
                    type="number"
                    min={1}
                    max={92}
                    placeholder="No limit (3 months)"
                    value={form.maxAdvance}
                    onChange={(e) => setForm({ ...form, maxAdvance: e.target.value })}
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="limit-occurrences">Most occurrences in a recurring series (1 to 12)</Label>
                  <Input
                    id="limit-occurrences"
                    type="number"
                    min={1}
                    max={12}
                    placeholder="No limit (12)"
                    value={form.maxOccurrences}
                    onChange={(e) => setForm({ ...form, maxOccurrences: e.target.value })}
                  />
                </div>
              </fieldset>

              <fieldset className="space-y-2" data-testid="room-access">
                <legend className="text-sm font-medium">Rooms this group can book</legend>

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.allRooms}
                    onCheckedChange={(checked) =>
                      setForm({ ...form, allRooms: checked === true })
                    }
                  />
                  All rooms (including rooms added later)
                </label>

                {!form.allRooms && (
                  <div className="space-y-2 rounded-lg border p-3">
                    {rooms.map((r) => (
                      <label key={r.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={form.roomIds.includes(r.id)}
                          onCheckedChange={(checked) =>
                            setForm({
                              ...form,
                              roomIds: toggleIn(form.roomIds, r.id, checked === true),
                            })
                          }
                        />
                        {r.name}
                      </label>
                    ))}

                    {form.roomIds.length === 0 && (
                      <p className="text-xs text-amber-700">Tick at least one room.</p>
                    )}
                  </div>
                )}
              </fieldset>

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
            <Button disabled={saving || !form?.name.trim()} onClick={submit}>
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
          {summary.mappedToGroup > 0
            ? `${summary.mappedToGroup} placed in a group from their Entra group. `
            : ""}
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

const INTERVALS = [1, 3, 6, 12, 24, 48, 168];

function EntraSettingsPanel({ groups }: { groups: GroupRow[] }) {
  const [settings, setSettings] = useState<EntraSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [directory, setDirectory] = useState<{ id: string; name: string }[] | null>(null);
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [entraId, setEntraId] = useState("");
  const [entraName, setEntraName] = useState("");
  const [targetGroup, setTargetGroup] = useState("");

  useEffect(() => {
    api<{ settings: EntraSettings }>("/api/admin/entra/settings")
      .then((data) => setSettings(data.settings))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not load the sync settings."));
  }, []);

  if (!settings) return null;

  const change = (next: EntraSettings) => {
    setSettings(next);
    setDirty(true);
  };

  const loadDirectory = async () => {
    setLoadingDirectory(true);

    try {
      const data = await api<{ groups: { id: string; name: string }[] }>("/api/admin/entra/groups");

      setDirectory(data.groups);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the Entra groups.");
    } finally {
      setLoadingDirectory(false);
    }
  };

  const addMapping = () => {
    const target = groups.find((g) => String(g.id) === targetGroup);

    if (!entraId.trim() || !target) return;

    if (settings.mappings.some((m) => m.entraGroupId === entraId.trim().toLowerCase())) {
      toast.error("That Entra group is already mapped.");

      return;
    }

    change({
      ...settings,
      mappings: [
        ...settings.mappings,
        {
          entraGroupId: entraId.trim().toLowerCase(),
          entraGroupName: entraName,
          groupId: target.id,
          groupName: target.name,
        },
      ],
    });
    setEntraId("");
    setEntraName("");
    setTargetGroup("");
  };

  const save = async () => {
    setSaving(true);

    try {
      const data = await api<{ settings: EntraSettings }>("/api/admin/entra/settings", "PUT", {
        autoSyncEnabled: settings.autoSyncEnabled,
        intervalHours: settings.intervalHours,
        mappings: settings.mappings.map((m) => ({
          entraGroupId: m.entraGroupId,
          entraGroupName: m.entraGroupName,
          groupId: m.groupId,
        })),
      });

      setSettings(data.settings);
      setDirty(false);
      toast.success("Sync settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="rounded-xl border bg-white p-4" data-testid="entra-settings">
      <summary className="cursor-pointer text-sm font-medium">Sync settings</summary>

      <div className="mt-4 space-y-5">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={settings.autoSyncEnabled}
              onCheckedChange={(checked) =>
                change({ ...settings, autoSyncEnabled: checked === true })
              }
            />
            Sync automatically
          </label>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Label htmlFor="sync-interval">Every</Label>
            <select
              id="sync-interval"
              className={selectClass}
              value={settings.intervalHours}
              disabled={!settings.autoSyncEnabled}
              onChange={(e) => change({ ...settings, intervalHours: Number(e.target.value) })}
            >
              {INTERVALS.map((h) => (
                <option key={h} value={h}>
                  {h === 168 ? "week" : h === 1 ? "hour" : h + " hours"}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Starting group by Entra security group</p>
            <p className="text-xs text-gray-500">
              The first time a person is synced and has no group, they start in the mapped group
              (the highest priority one if they are in several). Nobody who already has a group is
              moved; everyone else goes to the Employee group.
            </p>
          </div>

          {settings.mappings.length > 0 && (
            <ul className="divide-y rounded-lg border text-sm">
              {settings.mappings.map((m) => (
                <li key={m.entraGroupId} className="flex items-center justify-between gap-3 p-2">
                  <span className="min-w-0">
                    <span className="font-medium">{m.entraGroupName || m.entraGroupId}</span>
                    <span className="text-gray-500"> → {m.groupName}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      change({
                        ...settings,
                        mappings: settings.mappings.filter((x) => x.entraGroupId !== m.entraGroupId),
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="map-entra">Entra group</Label>
              {directory ? (
                <select
                  id="map-entra"
                  className={selectClass}
                  value={entraId}
                  onChange={(e) => {
                    const found = directory.find((d) => d.id === e.target.value);

                    setEntraId(e.target.value);
                    setEntraName(found?.name ?? "");
                  }}
                >
                  <option value="">Choose...</option>
                  {directory.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="map-entra"
                  className="w-72"
                  placeholder="Entra group object id (GUID)"
                  value={entraId}
                  onChange={(e) => setEntraId(e.target.value)}
                />
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="map-group">App group</Label>
              <select
                id="map-group"
                className={selectClass}
                value={targetGroup}
                onChange={(e) => setTargetGroup(e.target.value)}
              >
                <option value="">Choose...</option>
                {groups
                  .filter((g) => g.isActive)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </div>

            <Button variant="outline" onClick={addMapping} disabled={!entraId.trim() || !targetGroup}>
              Add
            </Button>

            {!directory && (
              <Button variant="ghost" onClick={() => void loadDirectory()} disabled={loadingDirectory}>
                {loadingDirectory ? "Loading..." : "Load groups from Entra"}
              </Button>
            )}
          </div>
        </div>

        <Button onClick={() => void save()} disabled={!dirty || saving} data-testid="save-entra-settings">
          {saving ? "Saving..." : "Save sync settings"}
        </Button>
      </div>
    </details>
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

/* --------------------------------- Page ----------------------------------- */

export default function GroupManagement({
  initialGroups,
  meetingTypes,
  rooms,
}: {
  initialGroups: GroupRow[];
  meetingTypes: MeetingTypeOption[];
  rooms: RoomOption[];
}) {
  const [groups, setGroups] = useState(initialGroups);

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
          book, their booking limits, and who belongs to each group.
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
        </TabsList>

        <TabsContent value="groups" className="pt-4">
          <GroupsTab groups={groups} meetingTypes={meetingTypes} rooms={rooms} reload={reload} />
        </TabsContent>

        <TabsContent value="employees" className="pt-4">
          <EmployeesTab groups={groups} reloadGroups={reload} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
