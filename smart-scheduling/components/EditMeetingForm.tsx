"use client";

import { useState } from "react";
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
import EmployeeMultiSelect from "@/components/EmployeeMultiSelect";
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
  optionalAttendeeIds: number[];
  meetingTypes: MeetingType[];
};

export default function EditMeetingForm({
  meetingId,
  title,
  meetingTypeId,
  attendeeIds,
  optionalAttendeeIds,
  meetingTypes,
}: Props) {

  const router = useRouter();

  const [meetingTitle, setMeetingTitle] =
    useState(title);

  const [selectedMeetingType, setSelectedMeetingType] =
    useState(String(meetingTypeId));

  const [attendees, setAttendees] =
    useState<number[]>(attendeeIds);

  // Invited but not essential. Never overlaps `attendees`.
  const [optionalAttendees, setOptionalAttendees] =
    useState<number[]>(optionalAttendeeIds);

  const setMandatory = (ids: number[]) => {
    setAttendees(ids);
    setOptionalAttendees((current) => current.filter((id) => !ids.includes(id)));
  };

  const setOptional = (ids: number[]) => {
    setOptionalAttendees(ids);
    setAttendees((current) => current.filter((id) => !ids.includes(id)));
  };

  // Everyone invited plus the organizer, who is always included.
  const headcount = attendees.length + optionalAttendees.length + 1;

  const [loading, setLoading] =
    useState(false);

  const handleUpdate = async () => {

    if (!meetingTitle.trim()) {
      toast.warning("Meeting title is required.");
      return;
    }

    setLoading(true);

    try {

const participantEmployeeIds = attendees;
      const optionalParticipantEmployeeIds = optionalAttendees;

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

            participantCount: headcount,

            meetingTypeId:
              Number(
                selectedMeetingType
              ),

            participantEmployeeIds,

            optionalParticipantEmployeeIds,
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
            value={headcount}
            readOnly
          />

        </div>

        {/* Attendees */}

        <div>

          <Label>
            Participants
          </Label>

          <EmployeeMultiSelect
            value={attendees}
            onChange={setMandatory}
            label="Participants"
            testId="participants"
            otherIds={optionalAttendees}
            otherLabel="Optional participants"
            onMoveHere={(id) => {
              setOptionalAttendees((current) => current.filter((v) => v !== id));
              setAttendees((current) => [...current, id]);
            }}
            onMoveOut={(id) => {
              setAttendees((current) => current.filter((v) => v !== id));
              setOptionalAttendees((current) => [...current, id]);
            }}
          />

        </div>

        {/* Optional attendees */}

        <div>

          <Label>
            Optional Participants
          </Label>

          <EmployeeMultiSelect
            value={optionalAttendees}
            onChange={setOptional}
            label="Optional participants"
            testId="optional-participants"
            otherIds={attendees}
            otherLabel="Participants"
            onMoveHere={(id) => {
              setAttendees((current) => current.filter((v) => v !== id));
              setOptionalAttendees((current) => [...current, id]);
            }}
            onMoveOut={(id) => {
              setOptionalAttendees((current) => current.filter((v) => v !== id));
              setAttendees((current) => [...current, id]);
            }}
          />

          <p className="mt-2 text-sm text-gray-500">
            The organizer is automatically included in the meeting.
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