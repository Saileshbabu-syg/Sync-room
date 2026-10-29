"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";


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
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

// Occurrence dates of a recurring series, and which of them the room cannot
// take. Shown in a dialog when a series is rejected.
type SeriesConflict = {
  dates: string[];
  conflicts: string[];
  // The request that was rejected, re-sent with `skip_dates` to book only the
  // free dates.
  payload: Record<string, unknown>;
};

// "YYYY-MM-DD" -> "Mon, 12 Oct 2026" (UTC, so the date never shifts a day).
const formatSeriesDate = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

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
  meetingDate: initialDate,
  startTime: initialStart,
  endTime: initialEnd,
  participantCount,
}: Props) {

    const router = useRouter();

  // Date and time arrive from the previous step and are read-only until the
  // user chooses "Change date or time" in the conflict dialog.
  const [editingSlot, setEditingSlot] = useState(false);
  const [meetingDate, setMeetingDate] = useState(initialDate);
  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);

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

  const [seriesConflict, setSeriesConflict] =
    useState<SeriesConflict | null>(null);

  const isDailyFrequency =
    frequencies.find((f) => String(f.frequency_id) === frequencyId)
      ?.frequency_name === "DAILY";

  const slotFieldClass = editingSlot
    ? ""
    : "bg-gray-100 text-gray-600 cursor-not-allowed";

const finishBooking = () => {
  // Clear saved booking forms
  sessionStorage.removeItem("bookMeetingForm");
  sessionStorage.removeItem("roomBookingForm");

  // Redirect to success page
  router.push("/booking/success");
};

const goBackToChange = () => {
  // Opened directly (no earlier page in this tab): start the booking flow.
  if (window.history.length <= 1) {
    router.push("/booking");
    return;
  }

  router.back();
};

// Re-sends the same series without the dates the room cannot take.
const bookAvailableDates = async () => {
  if (!seriesConflict) return;

  setLoading(true);

  try {
    const response = await fetch("/api/meetings/recurring", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...seriesConflict.payload,
        skip_dates: seriesConflict.conflicts,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      // Someone may have taken another date in the meantime; show the
      // updated picture instead of a bare error.
      if (Array.isArray(result.conflicts) && Array.isArray(result.occurrenceDates)) {
        setSeriesConflict({
          dates: seriesConflict.dates,
          conflicts: [
            ...new Set([...seriesConflict.conflicts, ...result.conflicts]),
          ],
          payload: seriesConflict.payload,
        });
        toast.error("Another date was just booked. Please review the list.");
      } else {
        toast.error(result.message ?? "Could not book the available dates.");
      }
      return;
    }

    setSeriesConflict(null);
    toast.success(`${result.data.length} meetings scheduled.`);
    finishBooking();
  } catch (error) {
    console.error(error);
    toast.error("Something went wrong.");
  } finally {
    setLoading(false);
  }
};

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

  if (!meetingDate || !startTime || !endTime) {
    toast.warning("Date, start time and end time are required.");
    return;
  }

  if (startTime >= endTime) {
    toast.warning("End time must be after start time.");
    return;
  }

  if (isRecurring) {
    if (!frequencyId) {
      toast.warning("Please select a recurrence frequency.");
      return;
    }

    if (isDailyFrequency) {
      const weekday = new Date(`${meetingDate}T00:00:00Z`).getUTCDay();

      if (weekday === 0 || weekday === 6) {
        toast.warning(
          "Daily meetings run Monday to Friday. Please choose a weekday as the start date."
        );
        return;
      }
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

    const recurringPayload = {
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
    };

    const response = isRecurring
      ? await fetch("/api/meetings/recurring", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(recurringPayload),
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
    if (Array.isArray(result.occurrenceDates)) {
      setSeriesConflict({
        dates: result.occurrenceDates,
        conflicts: result.conflicts,
        payload: recurringPayload,
      });
    } else {
      toast.error(
        `${result.message}: ${result.conflicts.join(", ")}`
      );
    }
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

finishBooking();

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
            type={editingSlot ? "date" : "text"}
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
            readOnly={!editingSlot}
            className={slotFieldClass}
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
            type={editingSlot ? "time" : "text"}
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            readOnly={!editingSlot}
            className={slotFieldClass}
          />

        </div>

        {/* End */}

        <div>

          <Label>
            End Time
          </Label>

          <Input
            type={editingSlot ? "time" : "text"}
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            readOnly={!editingSlot}
            className={slotFieldClass}
          />

          {editingSlot && (
            <p className="mt-2 text-sm text-gray-500">
              You can now change the date and time. The room stays the same.
            </p>
          )}

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

                {isDailyFrequency && (
                  <p className="mt-2 text-sm text-gray-500">
                    Daily meetings are booked Monday to Friday. Saturdays and
                    Sundays are skipped.
                  </p>
                )}

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

      <AlertDialog
        open={seriesConflict !== null}
        onOpenChange={(open) => {
          if (!open) setSeriesConflict(null);
        }}
      >
        {/* grid-cols-[minmax(0,1fr)] keeps the single column from growing to
            its widest child, which is what made the list overflow the card. */}
        <AlertDialogContent className="grid-cols-[minmax(0,1fr)] data-[size=default]:sm:max-w-xl">
          {seriesConflict && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Room is not free for the whole series
                </AlertDialogTitle>
                <AlertDialogDescription>
                  You asked for {seriesConflict.dates.length} meetings, but the
                  room is free for only{" "}
                  {seriesConflict.dates.length -
                    seriesConflict.conflicts.length}
                  . It is already booked on{" "}
                  {seriesConflict.conflicts.length === 1
                    ? "1 date"
                    : `${seriesConflict.conflicts.length} dates`}
                  , so nothing has been booked.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-1 text-sm">
                {seriesConflict.dates.map((date, index) => {
                  const taken = seriesConflict.conflicts.includes(date);

                  return (
                    <li
                      key={date}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 ${
                        taken
                          ? "border-red-200 bg-red-50 text-red-800"
                          : "border-green-200 bg-green-50 text-green-800"
                      }`}
                    >
                      <span>
                        {index + 1}. {formatSeriesDate(date)}
                      </span>
                      <span className="font-medium">
                        {taken ? "Already booked" : "Available"}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <AlertDialogFooter className="sm:flex-wrap">
                {/* The room is fixed on this page, so picking another room
                    means going back to the step that chose it (the
                    available-rooms list or the room's booking form, which
                    both restore what was entered). */}
                <AlertDialogCancel
                  disabled={loading}
                  onClick={goBackToChange}
                >
                  Choose a different room
                </AlertDialogCancel>

                <AlertDialogCancel
                  disabled={loading}
                  onClick={() => {
                    setEditingSlot(true);
                    toast.info("You can now edit the date and time.");
                  }}
                >
                  Change date or time
                </AlertDialogCancel>

                {seriesConflict.dates.length > seriesConflict.conflicts.length && (
                  <Button onClick={bookAvailableDates} disabled={loading}>
                    {loading
                      ? "Scheduling..."
                      : `Book ${
                          seriesConflict.dates.length -
                          seriesConflict.conflicts.length
                        } available date${
                          seriesConflict.dates.length -
                            seriesConflict.conflicts.length ===
                          1
                            ? ""
                            : "s"
                        }`}
                  </Button>
                )}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}