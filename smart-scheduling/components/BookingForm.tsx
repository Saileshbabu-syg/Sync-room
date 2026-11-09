"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { CalendarSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import TimeSelect from "@/components/TimeSelect";
import { focusNextOnEnter } from "@/lib/focusNextOnEnter";
import { formatTime } from "@/lib/format";
import { useAllowOvernight } from "@/lib/hooks/useAllowOvernight";
import { usePersistedForm } from "@/lib/hooks/usePersistedForm";
import { nowInAppTimezone } from "@/lib/time";
import {
  MIN_DURATION_MESSAGE,
  bookingWindowEnd,
  isLongEnough,
} from "@/lib/validations/date-time";

const EMPTY_FORM = {
  meetingDate: "",
  startTime: "",
  endTime: "",
  participantCount: "",
};

export default function BookingForm() {
  const router = useRouter();
  const allowOvernight = useAllowOvernight();

  const [loading, setLoading] = useState(false);

  // Restores a half-filled form from sessionStorage when the user comes back.
  const [formData, setFormData] = usePersistedForm(
    "bookMeetingForm",
    EMPTY_FORM
  );

  // Today's date in the application's time zone (the server's rule), not the
  // browser's: the bookable range is today .. today + 3 months.
const minDate = nowInAppTimezone().date;

const maxDate = bookingWindowEnd(minDate);

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

    // Validate meeting date ("YYYY-MM-DD" strings compare in date order)
if (
  formData.meetingDate < minDate ||
  formData.meetingDate > maxDate
) {
  toast.warning(
    "Meeting date must be between today and the next 3 months."
  );
  return;
}

// Validate Start Time (Minimum 15 minutes from now), on the application's
// clock: date and time as the server sees them.
const nowApp = nowInAppTimezone();

if (formData.meetingDate === nowApp.date) {

  // 15 minutes from now; past midnight nothing is left today.
  const lead = nowInAppTimezone(new Date(Date.now() + 15 * 60_000));

  const minimumTime =
    lead.date === nowApp.date ? lead.time.slice(0, 5) : "24:00";

  if (formData.startTime < minimumTime) {
    toast.warning(
      `Start time must be at least 15 minutes after the current time (${
        minimumTime === "24:00" ? "12:00 AM" : formatTime(minimumTime)
      }).`
    );
    return;
  }
}
    // Validate meeting duration

// Same rule as the server (lib/validations/date-time).
if (
  formData.endTime === formData.startTime ||
  !isLongEnough(formData.startTime, formData.endTime)
) {
  toast.warning(MIN_DURATION_MESSAGE);
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
    <div className="space-y-10" onKeyDown={focusNextOnEnter}>

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

          <TimeSelect
            value={formData.startTime}
            onChange={(v) => setFormData((prev) => ({ ...prev, startTime: v }))}
            placeholder="Select start time"
          />

        </div>

        {/* End */}

        <div className="space-y-2">

          <Label>End Time *</Label>

          <TimeSelect
            value={formData.endTime}
            onChange={(v) => setFormData((prev) => ({ ...prev, endTime: v }))}
            after={formData.startTime || undefined}
            overnight={allowOvernight}
            placeholder="Select end time"
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