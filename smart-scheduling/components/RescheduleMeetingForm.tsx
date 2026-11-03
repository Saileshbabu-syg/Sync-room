"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import TimeSelect from "@/components/TimeSelect";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

type RoomOption = {
  roomId: number;
  roomName: string;
  capacity: number;
};

type Props = {
  meetingId: number;
  title: string;
  roomId: number;
  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
  // When the meeting is cancelled automatically if still unchanged ("YYYY-MM-DD HH:mm").
  deadline: string | null;
  rooms: RoomOption[];
};

// For a meeting whose room was needed by a higher-priority meeting: pick another
// room, date or time before the deadline, or it is cancelled automatically.
export default function RescheduleMeetingForm({
  meetingId,
  title,
  roomId,
  meetingDate,
  startTime,
  endTime,
  participantCount,
  deadline,
  rooms,
}: Props) {
  const router = useRouter();

  const [room, setRoom] = useState(String(roomId));
  const [date, setDate] = useState(meetingDate);
  const [start, setStart] = useState(startTime.slice(0, 5));
  const [end, setEnd] = useState(endTime.slice(0, 5));
  const [loading, setLoading] = useState(false);

  const fits = rooms.filter((r) => r.capacity >= participantCount);

  const handleSubmit = async () => {
    if (!start || !end || !date) {
      toast.warning("Choose a date, start time and end time.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`/api/meetings/reschedule/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_id: Number(room),
          meeting_date: date,
          start_time: start,
          end_time: end,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        toast.warning(result.errors?.[0]?.message ?? result.message);
        return;
      }

      toast.success(result.message);
      router.push("/bookings");
      router.refresh();
    } catch (error) {
      console.error(error);
      toast.error("Unable to reschedule the meeting.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-white p-8 shadow">
      <h1 className="mb-2 text-3xl font-bold">Reschedule Meeting</h1>

      <p className="mb-8 text-gray-600">
        The room for <strong>{title}</strong> is needed for a higher-priority
        meeting.{" "}
        {deadline
          ? `Choose another room or time before ${deadline}; otherwise the meeting will be cancelled automatically.`
          : "Choose another room or time; otherwise the meeting will be cancelled automatically."}
      </p>

      <div className="space-y-6">
        <div>
          <Label>Room</Label>

          <Select value={room} onValueChange={setRoom}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              {fits.map((r) => (
                <SelectItem key={r.roomId} value={String(r.roomId)}>
                  {r.roomName} (capacity {r.capacity})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Meeting Date</Label>

          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <Label>Start Time</Label>
            <TimeSelect value={start} onChange={setStart} />
          </div>

          <div>
            <Label>End Time</Label>
            <TimeSelect value={end} onChange={setEnd} after={start} />
          </div>
        </div>

        <div className="flex gap-4">
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? "Saving..." : "Reschedule Meeting"}
          </Button>

          <Button
            variant="outline"
            onClick={() => router.push("/bookings")}
            disabled={loading}
          >
            Back
          </Button>
        </div>
      </div>
    </div>
  );
}
