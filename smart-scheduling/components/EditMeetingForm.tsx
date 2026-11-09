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
import SeriesScopeSelect, { type SeriesScope } from "@/components/SeriesScopeSelect";
import TimeSelect from "@/components/TimeSelect";
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
  // Part of a recurring series: the edit can apply to this occurrence, this
  // and the following ones, or every upcoming occurrence; for the last two a
  // new room and time of day can be given (each occurrence keeps its date).
  inSeries?: boolean;
  rooms?: { roomId: number; roomName: string }[];
};

export default function EditMeetingForm({
  meetingId,
  title,
  meetingTypeId,
  attendeeIds,
  optionalAttendeeIds,
  meetingTypes,
  inSeries = false,
  rooms = [],
}: Props) {

  const [scope, setScope] = useState<SeriesScope>("single");

  // Empty = keep each occurrence's current room / time.
  const [seriesRoom, setSeriesRoom] = useState("");
  const [seriesStart, setSeriesStart] = useState("");
  const [seriesEnd, setSeriesEnd] = useState("");

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

    if (Boolean(seriesStart) !== Boolean(seriesEnd)) {
      toast.warning("Choose both a new start and end time, or neither.");
      return;
    }

    const seriesWide = inSeries && scope !== "single";

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

            ...(inSeries ? { scope } : {}),

            ...(seriesWide && seriesRoom ? { room_id: Number(seriesRoom) } : {}),

            ...(seriesWide && seriesStart
              ? { start_time: seriesStart, end_time: seriesEnd }
              : {}),
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

        {inSeries && (
          <SeriesScopeSelect value={scope} onChange={setScope} name="edit-scope" />
        )}

        {inSeries && scope !== "single" && (
          <div className="space-y-4 rounded-lg border p-4">
            <p className="text-sm text-gray-600">
              Optional: move every occurrence in this range to another room
              and/or time of day. Each occurrence keeps its date. Leave empty
              to keep them where they are.
            </p>

            <div>
              <Label>Room</Label>
              <Select value={seriesRoom} onValueChange={setSeriesRoom}>
                <SelectTrigger>
                  <SelectValue placeholder="Keep current room" />
                </SelectTrigger>
                <SelectContent>
                  {rooms.map((r) => (
                    <SelectItem key={r.roomId} value={String(r.roomId)}>
                      {r.roomName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Start Time</Label>
                <TimeSelect value={seriesStart} onChange={setSeriesStart} />
              </div>
              <div>
                <Label>End Time</Label>
                <TimeSelect value={seriesEnd} onChange={setSeriesEnd} />
              </div>
            </div>
          </div>
        )}

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