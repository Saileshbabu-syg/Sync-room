"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, ChevronDownIcon, XIcon } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

type Employee = {
  employeeId: number;
  name: string;
  role: string;
};

type Props = {
  value: number[];
  onChange: (ids: number[]) => void;
  // Employees that cannot be picked (e.g. the organizer).
  excludeIds?: number[];
  // What this list is called in the page, for labels and test ids.
  label?: string;
  testId?: string;
  // The sibling list (mandatory vs optional). Its people are listed here too,
  // but only as "in <other list>" with a button that moves them across, so
  // nobody is ever in both.
  otherIds?: number[];
  otherLabel?: string;
  onMoveHere?: (id: number) => void;
  onMoveOut?: (id: number) => void;
};

type Position = { top: number; left: number; width: number };

export default function EmployeeMultiSelect({
  value,
  onChange,
  excludeIds = [],
  label = "Participants",
  testId = "participants",
  otherIds = [],
  otherLabel = "the other list",
  onMoveHere,
  onMoveOut,
}: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<Position | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/employees")
      .then((res) => res.json())
      .then((data) => setEmployees(data.data ?? []))
      .catch((error) => console.error(error));
  }, []);

  // The list is rendered in a portal (so no card can clip it) and positioned
  // from the input. Re-measure on every scroll (capture, so scrolling inside
  // any container counts) and resize so the list stays attached to the input.
  useEffect(() => {
    if (!open) return;

    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        setPosition({
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
        });
      }
    };

    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);

    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // Close on any click outside the input and the list.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;

      if (
        !anchorRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
        setSearch("");
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const selectable = employees.filter(
    (e) => !excludeIds.includes(e.employeeId)
  );
  const query = search.trim().toLowerCase();
  const filtered = selectable.filter(
    (e) =>
      !query ||
      e.name.toLowerCase().includes(query) ||
      e.role.toLowerCase().includes(query) ||
      String(e.employeeId).includes(query)
  );
  // In the order they were picked, so the newest chip is at the end.
  const selected = value
    .map((id) => selectable.find((e) => e.employeeId === id))
    .filter((e): e is Employee => Boolean(e));

  const toggle = (id: number) =>
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
    );

  return (
    <div>
      <div ref={anchorRef} className="relative">
        <Input
          value={search}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Tab") setOpen(false);
          }}
          placeholder={
            selected.length
              ? `${selected.length} selected - search to add more`
              : "Search employees by name, role or ID"
          }
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          data-testid={`${testId}-search`}
          className="pr-9"
        />
        <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-gray-500" />
      </div>

      {selected.length > 0 && (
        // One compact row that scrolls sideways, so a long list never makes the
        // page longer and never wraps onto several lines.
        <div
          className="mt-2 flex min-w-0 flex-nowrap gap-2 overflow-x-auto overscroll-x-contain rounded-md border border-dashed p-2"
          data-testid={`${testId}-chips`}
          role="list"
          aria-label={`Selected ${label.toLowerCase()}`}
        >
          {selected.map((e) => (
            <span
              key={e.employeeId}
              role="listitem"
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-gray-100 py-1 pl-3 pr-1 text-xs"
            >
              {e.name} (ID {e.employeeId})
              {onMoveOut && (
                <button
                  type="button"
                  aria-label={`Move ${e.name} to ${otherLabel}`}
                  title={`Move to ${otherLabel}`}
                  className="rounded-full p-1 hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onMoveOut(e.employeeId)}
                >
                  <ArrowRightLeft className="size-3" />
                </button>
              )}
              <button
                type="button"
                aria-label={`Remove ${e.name}`}
                className="rounded-full p-1 hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => toggle(e.employeeId)}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {open &&
        position &&
        createPortal(
          <div
            ref={listRef}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
            }}
            className="z-[100] rounded-md border bg-white p-2 shadow-lg"
          >
            <div className="mb-1 flex items-center justify-between px-2 text-xs text-gray-500">
              <span>
                {filtered.length} employee{filtered.length === 1 ? "" : "s"}
              </span>
              {value.length > 0 && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => onChange([])}
                >
                  Clear all
                </button>
              )}
            </div>

            <ul className="max-h-60 overflow-y-auto">
              {filtered.length === 0 && (
                <li className="px-2 py-2 text-sm text-gray-500">
                  No employees found.
                </li>
              )}

              {filtered.map((e) =>
                otherIds.includes(e.employeeId) ? (
                  <li
                    key={e.employeeId}
                    className="flex items-center gap-3 rounded px-2 py-2 text-sm text-gray-500"
                  >
                    <span className="size-4 shrink-0" />
                    <span className="flex-1">{e.name}</span>
                    <span className="text-xs">In {otherLabel}</span>
                    <button
                      type="button"
                      className="rounded border px-2 py-0.5 text-xs font-medium text-gray-800 hover:bg-gray-100"
                      onClick={() => onMoveHere?.(e.employeeId)}
                    >
                      Move here
                    </button>
                  </li>
                ) : (
                <li key={e.employeeId}>
                  <label className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm hover:bg-gray-100">
                    <Checkbox
                      checked={value.includes(e.employeeId)}
                      onCheckedChange={() => toggle(e.employeeId)}
                    />
                    <span className="flex-1">{e.name}</span>
                    <span className="text-xs text-gray-500">
                      ID {e.employeeId} · {e.role}
                    </span>
                  </label>
                </li>
                )
              )}
            </ul>
          </div>,
          document.body
        )}
    </div>
  );
}
