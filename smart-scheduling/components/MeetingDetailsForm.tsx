"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Toaster } from "@/components/ui/sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type MeetingType = {
  meetingTypeId: number;
  meetingTypeName: string;
};

type RecurrenceFrequency = {
  frequency_id: number;
  frequency_name: string;
};

const MAX_OCCURRENCES = 12;

type Props = {
  roomId: number;
  organizerEmployeeId: number;

  meetingDate: string;
  startTime: string;
  endTime: string;
  participantCount: number;
};



export default function MeetingDetailsForm({
  roomId,
  organizerEmployeeId,
  meetingDate,
  startTime,
  endTime,
  participantCount,
}: Props) {

    const router = useRouter();

  const [meetingTypes, setMeetingTypes] = useState<
    MeetingType[]
  >([]);

  const [meetingTypeId, setMeetingTypeId] =
    useState("");

  const [meetingTitle, setMeetingTitle] =
    useState("");

  const [attendeeIds, setAttendeeIds] =
    useState("");

  const [isRecurring, setIsRecurring] =
    useState(false);

  const [frequencies, setFrequencies] =
    useState<RecurrenceFrequency[]>([]);

  const [frequencyId, setFrequencyId] =
    useState("");

  const [occurrenceCount, setOccurrenceCount] =
    useState("2");

  useEffect(() => {
    fetch("/api/meeting-types")
      .then((res) => res.json())
      .then((data) => {
        setMeetingTypes(data.data);
      });

    fetch("/api/recurrence-frequencies")
      .then((res) => res.json())
      .then((data) => {
        setFrequencies(data.data ?? []);
      });
  }, []);

  const [loading, setLoading] = useState(false);

const handleSubmit = async () => {
  if (!meetingTypeId) {
    toast.warning("Please select a meeting type.");
    return;
  }

  if (!meetingTitle.trim()) {
    toast.warning("Meeting title is required.");
    return;
  }

  // Validate Attendee Employee IDs
const attendeeInput = attendeeIds.trim();

if (attendeeInput !== "") {

  const pattern = /^\d+(,\d+)*$/;

  if (!pattern.test(attendeeInput)) {
    toast.warning(
      "Employee ID is invalid"
    );
    return;
  }

}

  if (isRecurring) {
    if (!frequencyId) {
      toast.warning("Please select a recurrence frequency.");
      return;
    }

    const count = Number(occurrenceCount);

    if (!Number.isInteger(count) || count < 1 || count > MAX_OCCURRENCES) {
      toast.warning(
        `Occurrence count must be between 1 and ${MAX_OCCURRENCES}.`
      );
      return;
    }
  }

  setLoading(true);

  try {
    const participantEmployeeIds =
      attendeeInput === ""
        ? []
        : attendeeInput
            .split(",")
            .map((id) => Number(id));
    const uniqueIds = new Set(participantEmployeeIds);

if (uniqueIds.size !== participantEmployeeIds.length) {
  toast.warning("Duplicate employee IDs are not allowed.");
  return;
}

if (
  participantEmployeeIds.includes(
    organizerEmployeeId
  )
) {
  toast.warning(
    "Organizer cannot be added as an attendee."
  );
  return;
}

    const response = isRecurring
      ? await fetch("/api/meetings/recurring", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: meetingTitle,
            meeting_date: meetingDate,
            organizerEmployeeId,
            room_id: roomId,
            participantCount,
            meetingTypeId: Number(meetingTypeId),
            meetingStatusId: 1,
            start_time: startTime,
            end_time: endTime,
            frequency_id: Number(frequencyId),
            occurrence_count: Number(occurrenceCount),
            participantEmployeeIds,
          }),
        })
      : await fetch("/api/meetings/booking", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: meetingTitle,

            meeting_date: meetingDate,

            organizer_employee_id:
              organizerEmployeeId,

            room_id: roomId,

            participant_count:
              participantCount,

            meeting_type_id:
              Number(meetingTypeId),

            meeting_status_id: 1,

            start_time: startTime,

            end_time: endTime,

            participantEmployeeIds,
          }),
        });

    const result = await response.json();

    if (!response.ok) {
  if (isRecurring && Array.isArray(result.conflicts)) {
    toast.error(
      `${result.message}: ${result.conflicts.join(", ")}`
    );
  } else {
    toast.error(result.message);
  }
  return;
}

if (isRecurring) {
  toast.success(
    `${result.data.length} meetings scheduled.`
  );
}

// Clear saved booking forms
sessionStorage.removeItem(
  "bookMeetingForm"
);

sessionStorage.removeItem(
  "roomBookingForm"
);

// Redirect to success page
router.push("/booking/success");

    // Next step
    // Redirect to Success Page

  } catch (error) {
    console.error(error);

    toast.error("Something went wrong.");
  } finally {
    setLoading(false);
  }
};

  return (
    <div className="rounded-xl border bg-white p-8 shadow">

      <h2 className="mb-8 text-2xl font-bold">
        Meeting Information
      </h2>

      <div className="grid gap-6 md:grid-cols-2">

        {/* Meeting Date */}

        <div>

          <Label>
            Meeting Date
          </Label>

          <Input
            value={meetingDate}
            readOnly
            className="bg-gray-100 text-gray-600 cursor-not-allowed"
          />

        </div>

        {/* Participant */}

        <div>

          <Label>
            Participant Count
          </Label>

          <Input
            value={participantCount}
            readOnly
            className="bg-gray-100 text-gray-600 cursor-not-allowed"
          />

        </div>

        {/* Start */}

        <div>

          <Label>
            Start Time
          </Label>

          <Input
            value={startTime}
            readOnly
            className="bg-gray-100 text-gray-600 cursor-not-allowed"
          />

        </div>

        {/* End */}

        <div>

          <Label>
            End Time
          </Label>

          <Input
            value={endTime}
            readOnly
            className="bg-gray-100 text-gray-600 cursor-not-allowed"
          />

        </div>

      </div>

      <div className="mt-10 space-y-6">

        {/* Meeting Type */}

        <div>

          <Label>
            Meeting Type
          </Label>

          <Select
            value={meetingTypeId}
            onValueChange={setMeetingTypeId}
          >

            <SelectTrigger>

              <SelectValue placeholder="Select Meeting Type" />

            </SelectTrigger>

            <SelectContent>

              {meetingTypes.map((type) => (

                <SelectItem
                  key={type.meetingTypeId}
                  value={String(type.meetingTypeId)}
                >
                  {type.meetingTypeName}
                </SelectItem>

              ))}

            </SelectContent>

          </Select>

        </div>

        {/* Meeting Title */}

        <div>

          <Label>
            Meeting Title
          </Label>

          <Input
            placeholder="Enter Meeting Title"
            value={meetingTitle}
            onChange={(e) =>
              setMeetingTitle(e.target.value)
            }
          />

        </div>

        {/* Attendees */}

        <div>

          <Label>
            Attendee Employee IDs
          </Label>

          <Input
            placeholder="Example : 2,5,7"
            value={attendeeIds}
            onChange={(e) =>
              setAttendeeIds(e.target.value)
            }
          />

          <p className="mt-2 text-sm text-gray-500">
            The organizer is automatically included as an attendee.
          </p>

        </div>

        {/* Recurrence */}

        <div>

          <div className="flex items-center gap-2">

            <Checkbox
              id="isRecurring"
              checked={isRecurring}
              onCheckedChange={(checked) =>
                setIsRecurring(checked === true)
              }
            />

            <Label htmlFor="isRecurring" className="cursor-pointer">
              Make this a recurring meeting
            </Label>

          </div>

          {isRecurring && (

            <div className="mt-4 grid gap-6 md:grid-cols-2">

              <div>

                <Label>
                  Frequency
                </Label>

                <Select
                  value={frequencyId}
                  onValueChange={setFrequencyId}
                >

                  <SelectTrigger>

                    <SelectValue placeholder="Select Frequency" />

                  </SelectTrigger>

                  <SelectContent>

                    {frequencies.map((frequency) => (

                      <SelectItem
                        key={frequency.frequency_id}
                        value={String(frequency.frequency_id)}
                      >
                        {frequency.frequency_name}
                      </SelectItem>

                    ))}

                  </SelectContent>

                </Select>

              </div>

              <div>

                <Label>
                  Number Of Occurrences
                </Label>

                <Input
                  type="number"
                  min={1}
                  max={MAX_OCCURRENCES}
                  step={1}
                  value={occurrenceCount}
                  onChange={(e) =>
                    setOccurrenceCount(e.target.value)
                  }
                />

                <p className="mt-2 text-sm text-gray-500">
                  Up to {MAX_OCCURRENCES} occurrences.
                </p>

              </div>

            </div>

          )}

        </div>

      </div>

      <Button
  className="mt-10 w-full"
  onClick={handleSubmit}
  disabled={loading}
>
  {loading
    ? "Scheduling..."
    : "Confirm Booking"}
</Button>

    </div>
  );
}