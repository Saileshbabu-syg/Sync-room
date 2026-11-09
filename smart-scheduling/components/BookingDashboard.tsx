"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Loader2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Pagination from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { invitationCategory } from "@/lib/constants";
import { formatDate, formatEndTime, formatTime, formatTimeRange } from "@/lib/format";
import { addDays } from "@/lib/report-period";

type Option = { id: number; name: string };

type Props = {
  today: string;
  groups: Option[];
  rooms: Option[];
  statuses: { id: number; label: string }[];
};

type Metrics = {
  totalBookings: number;
  confirmedBookings: number;
  cancelledBookings: number;
  bumpedBookings: number;
  pendingBookings: number;
  totalMeetingHours: number;
  activeRooms: number;
};

const CARDS: { key: keyof Metrics; label: string }[] = [
  { key: "totalBookings", label: "Total Bookings" },
  { key: "confirmedBookings", label: "Confirmed Bookings" },
  { key: "pendingBookings", label: "Pending Reschedule" },
  { key: "cancelledBookings", label: "Cancelled Bookings" },
  { key: "bumpedBookings", label: "Replaced Bookings" },
  { key: "totalMeetingHours", label: "Total Meeting Hours" },
  { key: "activeRooms", label: "Active Meeting Rooms" },
];

type ReportFormat = "csv" | "xlsx" | "pdf";

const FORMATS: [ReportFormat, string][] = [
  ["xlsx", "Excel (.xlsx)"],
  ["csv", "CSV (.csv)"],
  ["pdf", "PDF (.pdf)"],
];

// filename="booking-report_2031-03-05.csv" from Content-Disposition.
function attachmentName(header: string | null): string | null {
  return header?.match(/filename="([^"]+)"/)?.[1] ?? null;
}

type Participant = {
  employeeId: number;
  name: string;
  email: string;
  response: string;
  isOptional: boolean;
};

// A booking that took the room of another one.
type Replaced = {
  bookingId: number;
  title: string;
  organizerName: string;
  organizerGroup: string | null;
  meetingType: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  reason: string;
  participants: Participant[];
};

// Who took a replaced booking's room.
type Bump = {
  participants: Participant[];
  byName: string;
  byGroup: string | null;
  title: string;
  meetingType: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  reason: string;
};

type Row = {
  bookingId: number;
  organizerName: string;
  meetingType: string;
  priorityAtBooking: number | null;
  title: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  statusId: number;
  status: string;
  participants: Participant[];
  bumped: Bump | null;
  replaced: Replaced[];
};

type Mode = "day" | "week" | "month" | "range";

const PAGE_SIZE = 10;

const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const RESPONSE_STYLE: Record<string, { label: string; className: string }> = {
  ACCEPTED: { label: "Accepted", className: "bg-green-100 text-green-800" },
  DECLINED: { label: "Declined", className: "bg-red-100 text-red-800" },
  NO_RESPONSE: { label: "No Response", className: "bg-gray-100 text-gray-700" },
};

const HEADERS = [
  "",
  "Organizer",
  "Meeting Type",
  "Priority",
  "Title",
  "Room",
  "Date",
  "Start",
  "End",
  "Status",
];

function ParticipantTable({ people }: { people: Participant[] }) {
  if (people.length === 0) {
    return <p className="text-sm text-gray-500">No participants were added to this meeting.</p>;
  }

  return (
    <table className="w-full max-w-4xl text-left text-sm">
      <thead className="text-xs uppercase text-gray-500">
        <tr>
          <th className="py-1 pr-4">Employee Name</th>
          <th className="py-1 pr-4">Employee ID</th>
          <th className="py-1 pr-4">Email Address</th>
          <th className="py-1 pr-4">Invitation Category</th>
          <th className="py-1">Response</th>
        </tr>
      </thead>
      <tbody>
        {people.map((p) => {
          const response = RESPONSE_STYLE[p.response] ?? RESPONSE_STYLE.NO_RESPONSE;

          return (
            <tr key={p.employeeId} className="border-t">
              <td className="py-2 pr-4 font-medium">{p.name}</td>
              <td className="py-2 pr-4">{p.employeeId}</td>
              <td className="py-2 pr-4 text-gray-600">{p.email}</td>
              <td className="py-2 pr-4">{invitationCategory(p.isOptional)}</td>
              <td className="py-2">
                <Badge className={response.className} variant="outline">
                  {response.label}
                </Badge>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function BookingDashboard({ today, groups, rooms, statuses }: Props) {
  const [mode, setMode] = useState<Mode>("day");
  const [date, setDate] = useState(today);
  const [rangeStart, setRangeStart] = useState(today);
  const [rangeEnd, setRangeEnd] = useState(today);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [statusId, setStatusId] = useState("");
  const [sort, setSort] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState<ReportFormat | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);

    return () => clearTimeout(timer);
  }, [search]);

  // The same query string drives the dashboard and the report download.
  const filterParams = useMemo(() => {
    const p = new URLSearchParams({ mode, sort });

    if (mode === "range") {
      p.set("start", rangeStart);
      p.set("end", rangeEnd);
    } else {
      p.set("date", date);
    }

    if (query) p.set("q", query);
    if (groupId) p.set("groupId", groupId);
    if (roomId) p.set("roomId", roomId);
    if (statusId) p.set("statusId", statusId);

    return p;
  }, [mode, date, rangeStart, rangeEnd, query, groupId, roomId, statusId, sort]);

  // The request in flight. Starting a new one (filters changed, Retry) aborts
  // it, so a slow earlier response can never overwrite a newer result.
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();

    const controller = new AbortController();

    request.current = controller;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams(filterParams);

      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));

      const response = await fetch(`/api/dashboard/bookings?${params}`, {
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));

      if (controller.signal.aborted) return;

      if (!response.ok) {
        throw new Error(data.message ?? "Could not load bookings.");
      }

      setMetrics(data.metrics);
      setRows(data.rows);
      setTotal(data.total);
      setOpen(new Set());

      // Fewer results than before (e.g. a booking was cancelled meanwhile):
      // go to the last page that still exists instead of an empty one.
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

      if (page > lastPage) setPage(lastPage);
    } catch (err) {
      if (controller.signal.aborted) return;

      // Nothing stale is left on screen looking current.
      setMetrics(null);
      setRows([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : "Could not load bookings.");
    } finally {
      if (request.current === controller) setLoading(false);
    }
  }, [filterParams, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The report download in progress, if any (cancelled on leaving the page).
  const report = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
      report.current?.abort();
    },
    []
  );

  const reset = (action: () => void) => {
    action();
    setPage(1);
  };

  // The range being shown, worked out the same way the server does.
  const periodText = useMemo(() => {
    if (mode === "range") return `${rangeStart} to ${rangeEnd}`;
    if (mode === "day") return date;

    try {
      if (mode === "week") return `${date} to ${addDays(date, 6)}`;

      const next = new Date(`${date}T00:00:00Z`);
      const day = next.getUTCDate();
      const last = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 2, 0)
      ).getUTCDate();
      const sameDay = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, Math.min(day, last))
      )
        .toISOString()
        .slice(0, 10);

      return `${date} to ${addDays(sameDay, -1)}`;
    } catch {
      return date;
    }
  }, [mode, date, rangeStart, rangeEnd]);

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });

  // Fetched rather than opened as a link, so a refusal (too many rows, rate
  // limit, permission withdrawn) is shown as a message instead of a broken
  // file, and the user sees when it is being prepared and when it is done.
  // The server caps the rows, which bounds what is held in memory here.
  const download = async (format: ReportFormat) => {
    if (report.current) return;

    const controller = new AbortController();
    const label = FORMATS.find(([f]) => f === format)?.[1] ?? format;

    report.current = controller;
    setDownloading(format);

    const toastId = toast.loading(`Preparing the ${label} report...`, {
      action: { label: "Cancel", onClick: () => controller.abort() },
    });

    try {
      const response = await fetch(`/api/dashboard/report?${filterParams}&format=${format}`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));

        throw new Error(data.message ?? "The report could not be created.");
      }

      const blob = await response.blob();
      const name = attachmentName(response.headers.get("content-disposition")) ?? `booking-report.${format}`;
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = href;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);

      toast.success("Report downloaded.", { id: toastId, description: name, action: undefined });
    } catch (err) {
      if (controller.signal.aborted) {
        toast.info("Download cancelled.", { id: toastId, action: undefined });
      } else {
        toast.error(err instanceof Error ? err.message : "The report could not be created.", {
          id: toastId,
          action: undefined,
        });
      }
    } finally {
      report.current = null;
      setDownloading(null);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="mt-2 text-gray-500">
            Meeting room booking activity across the organization.
          </p>
        </div>

        {/* Radix menu: Escape and a click outside close it, arrow keys move
            between formats, focus returns to the button. */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button size="lg" disabled={downloading !== null} data-testid="download-report">
              {downloading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Download className="mr-2 h-4 w-4" aria-hidden />
              )}
              {downloading ? "Preparing report..." : "Download Report"}
            </Button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              className="z-50 w-48 overflow-hidden rounded-lg border bg-white p-1 shadow-lg"
            >
              {FORMATS.map(([format, text]) => (
                <DropdownMenu.Item
                  key={format}
                  onSelect={() => void download(format)}
                  className="cursor-pointer rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-slate-100"
                >
                  {text}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* Period toolbar */}
      <div className="space-y-3 rounded-xl border bg-slate-50 p-4">
        <Tabs value={mode} onValueChange={(value) => reset(() => setMode(value as Mode))}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="day">Daily</TabsTrigger>
            <TabsTrigger value="week">Weekly</TabsTrigger>
            <TabsTrigger value="month">Monthly</TabsTrigger>
            <TabsTrigger value="range">Custom range</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-end gap-4">
          {mode !== "range" && (
            <div className="space-y-1">
              <Label htmlFor="dash-date">
                {mode === "day" ? "Date" : "Starting date"}
              </Label>
              <Input
                id="dash-date"
                type="date"
                value={date}
                onChange={(e) => e.target.value && reset(() => setDate(e.target.value))}
              />
            </div>
          )}

          {mode === "range" && (
            <>
              <div className="space-y-1">
                <Label htmlFor="dash-start">Start date</Label>
                <Input
                  id="dash-start"
                  type="date"
                  value={rangeStart}
                  max={rangeEnd}
                  onChange={(e) => e.target.value && reset(() => setRangeStart(e.target.value))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dash-end">End date</Label>
                <Input
                  id="dash-end"
                  type="date"
                  value={rangeEnd}
                  min={rangeStart}
                  onChange={(e) => e.target.value && reset(() => setRangeEnd(e.target.value))}
                />
              </div>
            </>
          )}

          <p className="pb-2 text-sm font-medium text-blue-700" data-testid="period-label">
            Showing {periodText}
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}{" "}
          <button className="underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {/* Cards: a placeholder while the first figures load, the previous
          figures dimmed while new ones load, and "unavailable" (not 0) when
          loading failed - an error never looks like an empty period. */}
      <div
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7"
        aria-busy={loading}
      >
        {CARDS.map((card) => (
          <div key={card.key} className="rounded-xl border bg-white p-4 shadow-sm" data-testid={`kpi-${card.key}`}>
            <p className="text-xs uppercase tracking-wide text-gray-500">{card.label}</p>

            {metrics ? (
              <p className={`mt-2 text-2xl font-bold transition-opacity ${loading ? "opacity-50" : ""}`}>
                {metrics[card.key]}
              </p>
            ) : loading ? (
              <div className="mt-3 h-7 w-16 animate-pulse rounded bg-slate-200" aria-hidden />
            ) : (
              <p className="mt-2 text-2xl font-bold text-gray-300" title="Could not be loaded">
                <span aria-hidden>-</span>
                <span className="sr-only">Unavailable</span>
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search organizer, email or title"
          maxLength={100}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search bookings"
        />

        <select className={selectClass} value={groupId} onChange={(e) => reset(() => setGroupId(e.target.value))} aria-label="Filter by group">
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>

        <select className={selectClass} value={roomId} onChange={(e) => reset(() => setRoomId(e.target.value))} aria-label="Filter by room">
          <option value="">All rooms</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>

        <select className={selectClass} value={statusId} onChange={(e) => reset(() => setStatusId(e.target.value))} aria-label="Filter by status">
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>

        <select className={selectClass} value={sort} onChange={(e) => reset(() => setSort(e.target.value as "asc" | "desc"))} aria-label="Sort order">
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-gray-500">
            <tr>
              {HEADERS.map((h, i) => (
                <th key={i} className={i === 0 ? "w-10 p-3" : "p-3"}>
                  {i === 0 ? <span className="sr-only">Participants</span> : h}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {loading && (
              <tr>
                <td colSpan={HEADERS.length} className="p-10 text-center text-gray-500">
                  Loading bookings...
                </td>
              </tr>
            )}

            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={HEADERS.length} className="p-10 text-center text-gray-500">
                  No bookings match the selected period and filters.
                </td>
              </tr>
            )}

            {!loading &&
              rows.map((r) => {
                const expanded = open.has(r.bookingId);

                return (
                  <Fragment key={r.bookingId}>
                    <tr className="border-t hover:bg-slate-50">
                      <td className="p-3">
                        <button
                          aria-label={`${expanded ? "Hide" : "Show"} details of ${r.title}`}
                          aria-expanded={expanded}
                          className="rounded p-1 hover:bg-slate-200"
                          onClick={() => toggle(r.bookingId)}
                        >
                          {expanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </td>
                      <td className="p-3 font-medium">{r.organizerName}</td>
                      <td className="p-3">{r.meetingType}</td>
                      <td className="p-3">
                        {r.priorityAtBooking === null ? "-" : `P${r.priorityAtBooking}`}
                      </td>
                      <td className="max-w-[220px] truncate p-3" title={r.title}>{r.title}</td>
                      <td className="p-3">{r.roomName}</td>
                      <td className="whitespace-nowrap p-3">{formatDate(r.meetingDate)}</td>
                      <td className="p-3">{formatTime(r.startTime)}</td>
                      <td className="p-3">{formatEndTime(r.startTime, r.endTime)}</td>
                      <td className="p-3">
                        <StatusBadge statusId={r.statusId} />
                      </td>
                    </tr>

                    {expanded && (
                      <tr className="bg-slate-50">
                        <td />
                        <td colSpan={HEADERS.length - 1} className="space-y-4 p-4">
                          <section className="space-y-2">
                            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                              Participants
                            </h3>
                            <ParticipantTable people={r.participants} />
                          </section>

                          {r.bumped && (
                            <section
                              className="max-w-4xl space-y-3 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm"
                              data-testid="bumped-details"
                            >
                              <p className="font-semibold text-orange-900">
                                Replaced by {r.bumped.byName}
                                {r.bumped.byGroup ? ` (${r.bumped.byGroup})` : ""}
                              </p>

                              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                                <div><dt className="inline font-medium">Meeting title: </dt><dd className="inline">{r.bumped.title}</dd></div>
                                <div><dt className="inline font-medium">Meeting type: </dt><dd className="inline">{r.bumped.meetingType}</dd></div>
                                <div><dt className="inline font-medium">Room: </dt><dd className="inline">{r.bumped.roomName}</dd></div>
                                <div><dt className="inline font-medium">Date: </dt><dd className="inline">{formatDate(r.bumped.meetingDate)}</dd></div>
                                <div>
                                  <dt className="inline font-medium">Time: </dt>
                                  <dd className="inline">{formatTimeRange(r.bumped.startTime, r.bumped.endTime)}</dd>
                                </div>
                                <div className="sm:col-span-2">
                                  <dt className="inline font-medium">Reason: </dt>
                                  <dd className="inline">{r.bumped.reason}</dd>
                                </div>
                              </dl>

                              <div className="space-y-2 rounded-md bg-white/70 p-3">
                                <h4 className="text-xs font-semibold uppercase tracking-wide text-orange-800">
                                  Replacement meeting participants
                                </h4>
                                <ParticipantTable people={r.bumped.participants} />
                              </div>
                            </section>
                          )}

                          {r.replaced.length > 0 && (
                            <section
                              className="max-w-4xl space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm"
                              data-testid="replaced-bookings"
                            >
                              <p className="font-semibold text-blue-900">
                                This booking replaced {r.replaced.length}{" "}
                                {r.replaced.length === 1 ? "booking" : "bookings"}
                              </p>

                              {r.replaced.map((o) => (
                                <div key={o.bookingId} className="space-y-2 rounded-md bg-white/70 p-3">
                                  <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                                    <div><dt className="inline font-medium">Meeting title: </dt><dd className="inline">{o.title}</dd></div>
                                    <div>
                                      <dt className="inline font-medium">Organizer: </dt>
                                      <dd className="inline">
                                        {o.organizerName}
                                        {o.organizerGroup ? ` (${o.organizerGroup})` : ""}
                                      </dd>
                                    </div>
                                    <div><dt className="inline font-medium">Meeting type: </dt><dd className="inline">{o.meetingType}</dd></div>
                                    <div><dt className="inline font-medium">Room: </dt><dd className="inline">{o.roomName}</dd></div>
                                    <div><dt className="inline font-medium">Date: </dt><dd className="inline">{formatDate(o.meetingDate)}</dd></div>
                                    <div>
                                      <dt className="inline font-medium">Time: </dt>
                                      <dd className="inline">{formatTimeRange(o.startTime, o.endTime)}</dd>
                                    </div>
                                  </dl>

                                  <ParticipantTable people={o.participants} />
                                </div>
                              ))}
                            </section>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pages={pages} onPage={setPage} noun="booking" total={total} />
    </div>
  );
}
