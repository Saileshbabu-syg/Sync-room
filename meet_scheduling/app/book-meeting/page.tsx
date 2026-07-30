"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";

export default function BookMeetingPage() {
  const [title, setTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [participantCount, setParticipantCount] = useState("");
  const [meetingTypeId, setMeetingTypeId] = useState("");
  const [participantIds, setParticipantIds] = useState("");


  const handleBookMeeting = async () => {
  try {
    const response = await fetch("/api/meetings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        meetingDate,
        organizerEmployeeId: 1,
        roomId: 1,
        participantCount: Number(participantCount),
        meetingTypeId: Number(meetingTypeId),
        meetingStatusId: 1,
        startTime,
        endTime,
        participantEmployeeIds: participantIds
          ? participantIds
              .split(",")
              .map((id) => Number(id.trim()))
          : [],
      }),
    });

    const data = await response.json();

console.log(response.status);
console.log(data);

    if (response.ok) {
      alert("Meeting booked successfully");
    } else {
      alert(data.message);
    }
  } catch (error) {
    alert("Something went wrong");
  }
};

 return (
  <div className="max-w-6xl mx-auto mt-10 grid grid-cols-2 gap-6">

    {/* Left Side - Room Details */}
    <Card>
      <CardHeader>
        <CardTitle>Room Details</CardTitle>
      </CardHeader>

      <CardContent>
      <img
      src="/images/meeting-room.jpg"
      alt="Meeting Room"
      className="w-full rounded-md mb-4"
    />

        <div className="space-y-2">
          <p><strong>Room Name:</strong> Conference Room A</p>
          <p><strong>Capacity:</strong> 10</p>
          <p><strong>Floor:</strong> 2</p>

          <div>
            <p className="font-semibold">Facilities</p>

            <ul className="list-disc ml-5 mt-2">
              <li>Projector</li>
              <li>Whiteboard</li>
              <li>Video Conference</li>
              <li>Air Conditioning</li>
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>

    {/* Right Side - Booking Form */}
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Book Meeting</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Fill in the details to schedule a meeting room.
          </p>
        </div>
      </CardHeader>

      <CardContent>
        <div className="space-y-5">

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Meeting Title
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Meeting Date
            </label>
            <Input
              type="date"
              min={new Date().toISOString().split("T")[0]}
              value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Start Time
            </label>
            <Input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              End Time
            </label>
            <Input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Participant Count
            </label>
            <Input
              type="number"
              value={participantCount}
              onChange={(e) => setParticipantCount(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Meeting Type
            </label>

            <Select
              value={meetingTypeId}
              onValueChange={setMeetingTypeId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select Meeting Type" />
              </SelectTrigger>

              <SelectContent>
                <SelectItem value="1">Team Meeting</SelectItem>
                <SelectItem value="2">Client Meeting</SelectItem>
                <SelectItem value="3">Interview</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Participant Employee IDs
            </label>

            <Input
              placeholder="1,2,3"
              value={participantIds}
              onChange={(e) => setParticipantIds(e.target.value)}
            />
          </div>

          <Button
            size="lg"
            className="w-full"
            onClick={handleBookMeeting}
          >
            Book Meeting
          </Button>

        </div>
      </CardContent>
    </Card>

  </div>
);
}