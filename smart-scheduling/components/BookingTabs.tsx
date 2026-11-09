"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

import BookingCard from "@/components/BookingCard";
import type { BumpDetails } from "@/components/BumpedDetails";
import Pagination from "@/components/Pagination";

import { Label } from "@/components/ui/label";

import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

import type { BookingTab } from "@/lib/services/my-bookings.service";

type Meeting = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
  roomName: string | null;
  meetingType: string | null;
  meetingStatusId: number;
  meetingStatus: string | null;
  canManage: boolean;
  bumped: BumpDetails | null;
  isOnline: boolean;
  onlineJoinUrl: string | null;
  onlineRequested: boolean;
  onlineStatus: string;
  recurringMeetingId?: number | null;
};

type Props = {
  // The current page of the selected tab (the server pages and filters).
  meetings: Meeting[];
  tab: BookingTab;
  counts: Record<BookingTab, number>;
  date: string;
  page: number;
  pages: number;
};

// Keyed by stable ids, not by their labels: renaming a label never changes
// which meetings a tab holds (the server decides that by status id).
const TABS: { id: BookingTab; label: string; noun: string }[] = [
  { id: "scheduled", label: "Scheduled", noun: "scheduled" },
  { id: "completed", label: "Completed", noun: "completed" },
  { id: "replaced", label: "Replaced Bookings", noun: "replaced" },
  { id: "cancelled", label: "Cancelled", noun: "cancelled" },
];

export default function BookingTabs({
  meetings,
  tab,
  counts,
  date,
  page,
  pages,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  // Tab, day and page live in the URL; a change starts at page 1 unless a page
  // is given.
  const go = (next: { tab?: BookingTab; date?: string; page?: number }) => {
    const params = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    const nextDate = next.date ?? date;
    const nextPage = next.page ?? 1;

    if (nextTab !== "scheduled") params.set("tab", nextTab);
    if (nextDate) params.set("date", nextDate);
    if (nextPage > 1) params.set("page", String(nextPage));

    const query = params.toString();

    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (

    <Tabs
      value={tab}
      onValueChange={(value) => go({ tab: value as BookingTab })}
      className="w-full"
    >

      <div className="space-y-6">

        <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">

          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} data-testid={`tab-${t.id}`}>
              {t.label} ({counts[t.id]})
            </TabsTrigger>
          ))}

        </TabsList>

        <div className="flex flex-wrap items-center gap-2">

          <Label htmlFor="bookings-date" className="text-sm font-medium">
            Filter by Date:
          </Label>

          {/* Remounted after each navigation so it shows the applied date. */}
          <Input
            key={date}
            id="bookings-date"
            type="date"
            defaultValue={date}
            onChange={(e) => go({ date: e.target.value })}
            className="w-44"
          />

          {date && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => go({ date: "" })}
            >
              Clear
            </Button>
          )}

        </div>

      </div>

      <TabsContent value={tab} className="mt-6">

        <div
          aria-busy={pending}
          className={`space-y-6 transition-opacity ${pending ? "opacity-60" : ""}`}
        >

          {meetings.length === 0 ? (

            <div className="rounded-xl border bg-white p-10 text-center shadow">

              <h2 className="text-xl font-semibold">
                {date ? "No Meetings Found" : `No ${current.label} Meetings`}
              </h2>

              <p className="mt-2 text-gray-500">
                {date
                  ? "No meetings found for the selected date."
                  : `No ${current.noun} meetings found.`}
              </p>

            </div>

          ) : (

            <div className="grid gap-6">

              {meetings.map((meeting) => (
                <BookingCard
                  key={meeting.meetingId}
                  meeting={meeting}
                />
              ))}

            </div>

          )}

          {counts[tab] > 0 && (
            <Pagination
              page={page}
              pages={pages}
              onPage={(next) => go({ page: next })}
              noun="meeting"
              total={counts[tab]}
            />
          )}

        </div>

      </TabsContent>

    </Tabs>

  );

}
