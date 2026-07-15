"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Toaster } from "@/components/ui/sonner";

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
import { toast } from "sonner";

type MeetingType = {
  meetingTypeId: number;
  meetingTypeName: string;
};

type Props = {
  meetingId: number;
  title: string;
  participantCount: number;
  meetingTypeId: number;
  attendeeIds: number[];
  meetingTypes: MeetingType[];
};

export default function EditMeetingForm({
  meetingId,
  title,
  participantCount,
  meetingTypeId,
  attendeeIds,
  meetingTypes,
}: Props) {

  const router = useRouter();

  const [meetingTitle, setMeetingTitle] =
    useState(title);

  const [selectedMeetingType, setSelectedMeetingType] =
    useState(String(meetingTypeId));

  const [attendees, setAttendees] =
    useState(attendeeIds.join(","));

  const [loading, setLoading] =
    useState(false);

  const handleUpdate = async () => {

    if (!meetingTitle.trim()) {
      toast.warning("Meeting title is required.");
      return;
    }

    setLoading(true);

    try {

      // Validate attendee IDs
const attendeeText = attendees.trim();

if (attendeeText !== "") {

  const pattern = /^\d+(,\d+)*$/;

  if (!pattern.test(attendeeText)) {
    toast.warning(
      "Employee ID is invalid"
    );
    setLoading(false);
    return;
  }
}

const participantEmployeeIds =
  attendeeText === ""
    ? []
    : attendeeText
        .split(",")
        .map((id) => Number(id.trim()));

              console.log({
  title: meetingTitle,
  participantCount,
  meetingTypeId: Number(selectedMeetingType),
  participantEmployeeIds,
});
      const response = await fetch(
        `/api/meetings/edit/${meetingId}`,
        {
          method: "PATCH",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            title: meetingTitle,

            participantCount,

            meetingTypeId:
              Number(
                selectedMeetingType
              ),

            participantEmployeeIds,
          }),
        }
      );

      const result =
        await response.json();

      if (!response.ok) {
  if (result.errors?.length > 0) {
    toast.error(result.errors[0].message);
  } else {
    toast.warning(result.message);
  }
  return;
}

      toast.success(result.message);

      router.push("/bookings");

      router.refresh();

    } catch (error) {

      console.error(error);

      toast.error(
        "Unable to update meeting."
      );

    } finally {

      setLoading(false);

    }

  };

  return (
    <div className="rounded-2xl border bg-white p-8 shadow">

      <h1 className="mb-8 text-3xl font-bold">
        Edit Meeting
      </h1>

      <div className="space-y-6">

        {/* Meeting Title */}

        <div>

          <Label>
            Meeting Title
          </Label>

          <Input
            value={meetingTitle}
            onChange={(e) =>
              setMeetingTitle(
                e.target.value
              )
            }
          />

        </div>

        {/* Meeting Type */}

        <div>

          <Label>
            Meeting Type
          </Label>

          <Select
            value={selectedMeetingType}
            onValueChange={
              setSelectedMeetingType
            }
          >

            <SelectTrigger>

              <SelectValue />

            </SelectTrigger>

            <SelectContent>

              {meetingTypes.map((type) => (

                <SelectItem
                  key={
                    type.meetingTypeId
                  }
                  value={String(
                    type.meetingTypeId
                  )}
                >
                  {
                    type.meetingTypeName
                  }
                </SelectItem>

              ))}

            </SelectContent>

          </Select>

        </div>

        {/* Participant Count */}

        <div>

          <Label>
            Participant Count
          </Label>

          <Input
            value={participantCount}
            readOnly
          />

        </div>

        {/* Attendees */}

        <div>

          <Label>
            Attendee Employee IDs
          </Label>

          <Input
            value={attendees}
            placeholder="Example : 2,5,7"
            onChange={(e) =>
              setAttendees(
                e.target.value
              )
            }
          />

          <p className="mt-2 text-sm text-gray-500">
            Enter employee IDs separated by commas.
            Organizer is added automatically.
          </p>

        </div>

        

        {/* Buttons */}

        <div className="flex gap-4 pt-6">

          <Button
            variant="outline"
            onClick={() =>
              router.back()
            }
          >
            Cancel
          </Button>

          <Button
            onClick={handleUpdate}
            disabled={loading}
          >
            {loading
              ? "Updating..."
              : "Update Meeting"}
          </Button>

        </div>

      </div>

    </div>

    
  );
}