"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";

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
};

export default function EmployeeMultiSelect({
  value,
  onChange,
  excludeIds = [],
}: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/employees")
      .then((res) => res.json())
      .then((data) => setEmployees(data.data ?? []))
      .catch((error) => console.error(error));
  }, []);

  // Close when clicking outside the dropdown.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const selectable = employees.filter((e) => !excludeIds.includes(e.employeeId));
  const query = search.trim().toLowerCase();
  const filtered = selectable.filter(
    (e) =>
      !query ||
      e.name.toLowerCase().includes(query) ||
      e.role.toLowerCase().includes(query) ||
      String(e.employeeId).includes(query)
  );
  const selected = selectable.filter((e) => value.includes(e.employeeId));

  const toggle = (id: number) =>
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
    );

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          value={search}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          placeholder={
            selected.length
              ? `${selected.length} attendee${selected.length === 1 ? "" : "s"} selected - search to add more`
              : "Select attendees (search by name, role or ID)"
          }
          className="pr-9"
        />
        <ChevronDownIcon
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-gray-500"
        />
      </div>

      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {selected.map((e) => (
            <span
              key={e.employeeId}
              className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs"
            >
              {e.name} (ID {e.employeeId})
              <button
                type="button"
                aria-label={`Remove ${e.name}`}
                onClick={() => toggle(e.employeeId)}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-white p-2 shadow-lg">
          <ul className="max-h-60 overflow-y-auto">
            {filtered.length === 0 && (
              <li className="px-2 py-2 text-sm text-gray-500">
                No employees found.
              </li>
            )}

            {filtered.map((e) => (
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
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
