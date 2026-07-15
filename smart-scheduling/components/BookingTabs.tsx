"use client";

import { useState } from "react";

import BookingCard from "@/components/BookingCard";

import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Meeting = {
  meetingId: number;
  title: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
  roomName: string | null;
  meetingType: string | null;
  meetingStatus: string | null;
};

type Props = {
  meetings: Meeting[];
};

export default function BookingTabs({
  meetings,
}: Props) {

  const [activeTab, setActiveTab] =
    useState("Scheduled");

    const [selectedDate, setSelectedDate] =
  useState("");

  const filterByDate = (
  meetings: Meeting[]
) => {

  if (!selectedDate) {
    return meetings;
  }

  return meetings.filter(
    (meeting) =>
      meeting.meetingDate ===
      selectedDate
  );

};

 const scheduledMeetings = filterByDate(
  meetings.filter(
    (meeting) =>
      meeting.meetingStatus ===
      "Scheduled"
  )
);

const completedMeetings = filterByDate(
  meetings.filter(
    (meeting) =>
      meeting.meetingStatus ===
      "Completed"
  )
);

const cancelledMeetings = filterByDate(
  meetings.filter(
    (meeting) =>
      meeting.meetingStatus ===
      "Cancelled"
  )
);

    

  const renderMeetings = (
    data: Meeting[],
    status: string
  ) => {

    if (data.length === 0) {

      return (

        <div className="rounded-xl border bg-white p-10 text-center shadow">

         <h2 className="text-xl font-semibold">

  {selectedDate
    ? "No Meetings Found"
    : `No ${status} Meetings`}

</h2>

<p className="mt-2 text-gray-500">

  {selectedDate
    ? "No meetings found for the selected date."
    : `No ${status.toLowerCase()} meetings found.`}

</p>

        </div>

      );

    }

    return (

      <div className="grid gap-6">

        {data.map((meeting) => (

          <BookingCard
            key={meeting.meetingId}
            meeting={meeting}
          />

        ))}

      </div>

    );

  };

  return (

    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className="w-full"
    >

      <div className="space-y-6">

  <TabsList className="grid w-full grid-cols-3">

    <TabsTrigger value="Scheduled">
      Scheduled ({scheduledMeetings.length})
    </TabsTrigger>

    <TabsTrigger value="Completed">
      Completed ({completedMeetings.length})
    </TabsTrigger>

    <TabsTrigger value="Cancelled">
      Cancelled ({cancelledMeetings.length})
    </TabsTrigger>

  </TabsList>

  <div className="flex items-end gap-4">

    <div className="flex-1">

      <label className="mb-2 block text-sm font-medium">

        Filter by Meeting Date

      </label>

      <Input
        type="date"
        value={selectedDate}
        onChange={(e) =>
          setSelectedDate(e.target.value)
        }
      />

    </div>

    {selectedDate && (

      <Button
        variant="outline"
        onClick={() =>
          setSelectedDate("")
        }
      >

        Clear

      </Button>

    )}

  </div>

</div>

<TabsContent value="Scheduled">

  {renderMeetings(
    scheduledMeetings,
    "Scheduled"
  )}

</TabsContent>

<TabsContent value="Completed">

  {renderMeetings(
    completedMeetings,
    "Completed"
  )}

</TabsContent>

<TabsContent value="Cancelled">

  {renderMeetings(
    cancelledMeetings,
    "Cancelled"
  )}

</TabsContent>

    </Tabs>

  );

}