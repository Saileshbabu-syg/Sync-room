"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Button } from "@/components/ui/button";

type MeetingType = {
  meetingTypeId: number;
  meetingTypeName: string;
};

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

  useEffect(() => {
    fetch("/api/meeting-types")
      .then((res) => res.json())
      .then((data) => {
        setMeetingTypes(data.data);
      });
  }, []);

  const [loading, setLoading] = useState(false);

const handleSubmit = async () => {
  if (!meetingTypeId) {
    alert("Please select a meeting type.");
    return;
  }

  if (!meetingTitle.trim()) {
    alert("Meeting title is required.");
    return;
  }

  // Validate Attendee Employee IDs
const attendeeInput = attendeeIds.trim();

if (attendeeInput !== "") {

  const pattern = /^\d+(,\d+)*$/;

  if (!pattern.test(attendeeInput)) {
    alert(
      "Employee IDs must contain only numbers separated by commas.\nExample: 2,5,7"
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
  alert("Duplicate employee IDs are not allowed.");
  return;
}

if (
  participantEmployeeIds.includes(
    organizerEmployeeId
  )
) {
  alert(
    "Organizer cannot be added as an attendee."
  );
  return;
}

    const response = await fetch("/api/meetings/booking", {
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
      alert(result.message);
      return;
    }

    router.push("/booking/success");

    // Next step
    // Redirect to Success Page

  } catch (error) {
    console.error(error);

    alert("Something went wrong.");
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
            Separate employee IDs using commas.
          </p>

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