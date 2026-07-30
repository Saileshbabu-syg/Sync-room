"use client";

import { useEffect, useState, } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { CalendarSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function BookingForm() {
  const router = useRouter();

  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    meetingDate: "",
    startTime: "",
    endTime: "",
    participantCount: "",
  });

 useEffect(() => {
  const saved = sessionStorage.getItem("bookMeetingForm");

  if (saved) {
    setFormData(JSON.parse(saved));
  }
}, []);

  // Today's date
const today = new Date();

// Minimum selectable date (Today)
const minDate = today.toISOString().split("T")[0];

// Maximum selectable date (Today + 3 Months)
const maxDateObject = new Date(today);
maxDateObject.setMonth(maxDateObject.getMonth() + 3);

const maxDate = maxDateObject.toISOString().split("T")[0];

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSearch = async () => {
    if (
      !formData.meetingDate ||
      !formData.startTime ||
      !formData.endTime ||
      !formData.participantCount
    ) {
      toast.warning(
  "Please fill all required fields."
);
      return;
    }

    if (Number(formData.participantCount) <= 0) {
  toast.warning(
    "Participant count must be at least 1."
  );
  return;
}

    // Validate meeting date
const selectedDate = new Date(formData.meetingDate);

if (
  selectedDate < new Date(minDate) ||
  selectedDate > new Date(maxDate)
) {
  toast.warning(
    "Meeting date must be between today and the next 3 months."
  );
  return;
}

// Validate Start Time (Minimum 15 minutes from now)
const now = new Date();

const todayString = now.toISOString().split("T")[0];

if (formData.meetingDate === todayString) {

  // Add 15 minutes to current time
  now.setMinutes(now.getMinutes() + 15);

  const minimumTime =
    now.getHours().toString().padStart(2, "0") +
    ":" +
    now.getMinutes().toString().padStart(2, "0");

  if (formData.startTime < minimumTime) {
    toast.warning(
      `Start time must be at least 15 minutes after the current time (${minimumTime}).`
    );
    return;
  }
}
    // Validate meeting duration

const start = new Date(
  `${formData.meetingDate}T${formData.startTime}`
);

const end = new Date(
  `${formData.meetingDate}T${formData.endTime}`
);

const duration =
  (end.getTime() - start.getTime()) / 60000;

if (duration < 15) {
  toast.warning(
    "Meeting duration must be at least 15 minutes."
  );
  return;
}

    setLoading(true);

    try {
      const response = await fetch("/api/meetings/suggestions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          meeting_date: formData.meetingDate,
          start_time: formData.startTime,
          end_time: formData.endTime,
           participant_count: Number(
    formData.participantCount
  ),
        }),
      });

     const result = await response.json();

if (!response.ok || !result.success) {
  toast.error(
    result.message || "Unable to fetch rooms."
  );
  return;
}

// No rooms available
if (
  !result.data ||
  result.data.length === 0
) {
  toast.warning(
    `No meeting room can accommodate ${formData.participantCount} participants. The maximum room capacity is ${result.maxCapacity}.`
  );
  return;
}
const query = new URLSearchParams({
  date: formData.meetingDate,
  start: formData.startTime,
  end: formData.endTime,
  participants: formData.participantCount,
});

sessionStorage.setItem(
  "bookMeetingForm",
  JSON.stringify(formData)
);

router.push(
  `/booking/available-rooms?${query.toString()}`
);
    } catch (error) {
      console.error(error);
      toast.error("Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-10">

      {/* Heading */}

      <div>

        <h1 className="text-3xl font-bold">
          Book Meeting
        </h1>

        <p className="mt-2 text-gray-500">
          Enter meeting details to search for
          available meeting rooms.
        </p>

      </div>

      {/* Form */}

      <div className="grid gap-8 md:grid-cols-2">

        {/* Date */}

        <div className="space-y-2">

          <Label>Meeting Date *</Label>

          <Input
  type="date"
  name="meetingDate"
  value={formData.meetingDate}
  onChange={handleChange}
  min={minDate}
  max={maxDate}
/>

        </div>

        {/* Participant */}

        <div className="space-y-2">

          <Label>Participant Count *</Label>

          <Input
            type="number"
            min={1}
            step={1}
            name="participantCount"
            placeholder="Enter participant count"
            value={formData.participantCount}
            onChange={handleChange}
          />

        </div>

        {/* Start */}

        <div className="space-y-2">

          <Label>Start Time *</Label>

          <Input
            type="time"
            name="startTime"
            value={formData.startTime}
            onChange={handleChange}
          />

        </div>

        {/* End */}

        <div className="space-y-2">

          <Label>End Time *</Label>

          <Input
            type="time"
            name="endTime"
            value={formData.endTime}
            onChange={handleChange}
          />

        </div>

      </div>

      {/* Button */}

      <div>

        <Button
          size="lg"
          onClick={handleSearch}
          disabled={loading}
        >

          <CalendarSearch className="mr-2 h-5 w-5" />

          {loading
            ? "Searching..."
            : "Search Available Rooms"}

        </Button>

      </div>

    </div>
  );
}