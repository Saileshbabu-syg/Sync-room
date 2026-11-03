"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CalendarCheck,
  CalendarClock,
  ChevronDown,
} from "lucide-react";


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
import EmployeeMultiSelect from "@/components/EmployeeMultiSelect";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import TimeSelect from "@/components/TimeSelect";
import { formKeyNavigation } from "@/lib/focusNextOnEnter";
import { toast } from "sonner";
import { isSlotStartInPast, nowInAppTimezone } from "@/lib/time";
import { addDays } from "@/lib/report-period";

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
  // 1 = highest ... 5 = lowest.
  priorityRank: number;
};

// One booking already in the room on the chosen date.
type BookedSlot = {
  title: string;
  startTime: string;
  endTime: string;
  status: string | null;
  priorityRank: number;
  meetingTypeName: string;
  isOwn: boolean;
};

type RecurrenceFrequency = {
  frequency_id: number;
  frequency_name: string;
};

const MAX_OCCURRENCES = 12;

type Props = {
  roomId: number;
  organizerEmployeeId: number;
  roomCapacity: number;

  // Prefilled when the user arrives from the available-rooms list; empty when
  // they open the room directly.
  meetingDate: string;
  startTime: string;
  endTime: string;
};

export default function MeetingDetailsForm({
  roomId,
  organizerEmployeeId,
  roomCapacity,
  meetingDate: initialDate,
  startTime: initialStart,
  endTime: initialEnd,
}: Props) {

    const router = useRouter();

  const [meetingDate, setMeetingDate] = useState(initialDate);
  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);

  // The room's bookings on the chosen date, shown so the user can see what is
  // free before confirming.
  const [bookedSlots, setBookedSlots] = useState<BookedSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsOpen, setSlotsOpen] = useState(false);

  // Asked before taking a slot from lower-priority meetings.
  const [confirmTakeover, setConfirmTakeover] = useState(false);

  const [meetingTypes, setMeetingTypes] = useState<
    MeetingType[]
  >([]);

  const [meetingTypeId, setMeetingTypeId] =
    useState("");

  const [meetingTitle, setMeetingTitle] =
    useState("");

  const [attendeeIds, setAttendeeIds] =
    useState<number[]>([]);

  // Invited but not essential. Never overlaps attendeeIds: the two setters
  // below take a person out of one list when they are put in the other.
  const [optionalIds, setOptionalIds] =
    useState<number[]>([]);

  const setMandatory = (ids: number[]) => {
    setAttendeeIds(ids);
    setOptionalIds((current) => current.filter((id) => !ids.includes(id)));
  };

  const setOptional = (ids: number[]) => {
    setOptionalIds(ids);
    setAttendeeIds((current) => current.filter((id) => !ids.includes(id)));
  };

  // What this person's group allows (advisory: the server checks every rule).
  const [policy, setPolicy] = useState<{
    canBookRecurring: boolean;
    maxDurationMinutes: number | null;
    maxAdvanceDays: number | null;
    maxOccurrences: number | null;
  }>({
    canBookRecurring: true,
    maxDurationMinutes: null,
    maxAdvanceDays: null,
    maxOccurrences: null,
  });

  useEffect(() => {
    fetch("/api/booking-policy")
      .then((res) => res.json())
      .then((data) => data.policy && setPolicy(data.policy))
      .catch(() => undefined);
  }, []);

  const occurrenceLimit = Math.min(MAX_OCCURRENCES, policy.maxOccurrences ?? MAX_OCCURRENCES);

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

  useEffect(() => {
    if (!meetingDate || !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
      setBookedSlots([]);
      return;
    }

    let cancelled = false;

    setSlotsLoading(true);

    fetch(`/api/rooms/${roomId}/schedule?date=${meetingDate}`)
      .then((res) => res.json())
      .then((result) => {
        if (!cancelled) setBookedSlots(result.success ? result.data : []);
      })
      .catch(() => {
        if (!cancelled) setBookedSlots([]);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId, meetingDate]);

  const [loading, setLoading] = useState(false);

  const [seriesConflict, setSeriesConflict] =
    useState<SeriesConflict | null>(null);

  const isDailyFrequency =
    frequencies.find((f) => String(f.frequency_id) === frequencyId)
      ?.frequency_name === "DAILY";

  // "Today" in the application timezone (the same clock the server uses), so
  // the date picker never offers a past day.
  const todayDate = nowInAppTimezone().date;

  // Shown under the slot fields and checked again before submitting; the API
  // refuses past slots too, so this is only the early, friendly message.
  const slotError =
    meetingDate && meetingDate < todayDate
      ? "The date cannot be earlier than today."
      : meetingDate &&
          startTime &&
          /^\d{2}:\d{2}/.test(startTime) &&
          isSlotStartInPast(meetingDate, startTime.slice(0, 5))
        ? "The start time has already passed. Choose a later time."
        : policy.maxDurationMinutes !== null &&
            startTime &&
            endTime &&
            startTime < endTime &&
            (Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3, 5))) -
              (Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3, 5))) >
              policy.maxDurationMinutes
          ? `Your group can book meetings of at most ${policy.maxDurationMinutes} minutes.`
          : meetingDate &&
              policy.maxAdvanceDays !== null &&
              meetingDate > addDays(todayDate, policy.maxAdvanceDays)
            ? `Your group can book at most ${policy.maxAdvanceDays} days ahead.`
            : null;

  // The headcount is everyone invited (optional ones may come) plus the
  // organizer, who is added automatically.
  const participantNumber = attendeeIds.length + optionalIds.length + 1;

  const selectedType = meetingTypes.find(
    (type) => String(type.meetingTypeId) === meetingTypeId
  );

  // Bookings that overlap the chosen time (half-open, like the server).
  const overlapping =
    startTime && endTime && startTime < endTime
      ? bookedSlots.filter(
          (slot) =>
            slot.startTime.slice(0, 5) < endTime &&
            slot.endTime.slice(0, 5) > startTime
        )
      : [];

  // The chosen type outranks a booking when its rank number is lower. Those
  // bookings are listed apart: the room can be taken over from them.
  const isLowerPriority = (slot: BookedSlot) =>
    selectedType !== undefined && slot.priorityRank > selectedType.priorityRank;

  const takeoverSlots = bookedSlots.filter(isLowerPriority);
  const fixedSlots = bookedSlots.filter((slot) => !isLowerPriority(slot));

  // Every overlapping booking could be taken over, so confirming bumps them.
  const willTakeOver =
    overlapping.length > 0 && overlapping.every(isLowerPriority);

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

const handleSubmit = async (takeoverConfirmed = false) => {
  if (!meetingTypeId) {
    toast.warning("Please select a meeting type.");
    return;
  }

  if (!meetingTitle.trim()) {
    toast.warning("Meeting title is required.");
    return;
  }

  if (!meetingDate || !startTime || !endTime) {
    toast.warning("Date, start time and end time are required.");
    return;
  }

  if (slotError) {
    toast.warning(slotError);
    return;
  }

  if (startTime >= endTime) {
    toast.warning("End time must be after start time.");
    return;
  }

  if (isRecurring && policy.canBookRecurring) {
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

    if (!Number.isInteger(count) || count < 1 || count > occurrenceLimit) {
      toast.warning(
        `Occurrence count must be between 1 and ${occurrenceLimit}.`
      );
      return;
    }
  }

  // The room is held by lower-priority meetings that this booking would move
  // or cancel: say so and wait for a yes instead of booking silently.
  if (willTakeOver && !takeoverConfirmed) {
    setConfirmTakeover(true);
    return;
  }

  setLoading(true);

  try {
    const participantEmployeeIds = attendeeIds;
    const optionalParticipantEmployeeIds = optionalIds;

    const recurringPayload = {
      title: meetingTitle,
      meeting_date: meetingDate,
      organizerEmployeeId,
      room_id: roomId,
      participantCount: participantNumber,
      meetingTypeId: Number(meetingTypeId),
      meetingStatusId: 1,
      start_time: startTime,
      end_time: endTime,
      frequency_id: Number(frequencyId),
      occurrence_count: Number(occurrenceCount),
      participantEmployeeIds,
      optionalParticipantEmployeeIds,
    };

    const response = isRecurring && policy.canBookRecurring
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
              participantNumber,

            meeting_type_id:
              Number(meetingTypeId),

            meeting_status_id: 1,

            start_time: startTime,

            end_time: endTime,

            participantEmployeeIds,

            optionalParticipantEmployeeIds,
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
    <div
      className="rounded-xl border bg-white p-8 shadow"
      onKeyDown={formKeyNavigation}
    >

      <h2 className="mb-8 text-2xl font-bold">
        Meeting Information
      </h2>

      {/* Meeting Type: first, because it decides which bookings can be taken over. */}

      <div className="mb-6">

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

      <div className="grid gap-6 md:grid-cols-2">

        {/* Meeting Date */}

        <div className="md:col-span-2">

          <Label>
            Meeting Date
          </Label>

          <Input
            type="date"
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
            min={todayDate}
            aria-invalid={slotError ? true : undefined}
            className="md:max-w-xs"
          />

        </div>

        {/* Participants and optional participants, directly below the date */}

        <div className="md:col-span-2">

          <div className="grid gap-6 md:grid-cols-2">

            <div className="min-w-0">

              <Label>
                Participants
              </Label>

              <EmployeeMultiSelect
                value={attendeeIds}
                onChange={setMandatory}
                excludeIds={[organizerEmployeeId]}
                label="Participants"
                testId="participants"
                otherIds={optionalIds}
                otherLabel="Optional participants"
                onMoveHere={(id) => {
                  setOptionalIds((current) => current.filter((v) => v !== id));
                  setAttendeeIds((current) => [...current, id]);
                }}
                onMoveOut={(id) => {
                  setAttendeeIds((current) => current.filter((v) => v !== id));
                  setOptionalIds((current) => [...current, id]);
                }}
              />

            </div>

            <div className="min-w-0">

              <Label>
                Optional Participants
              </Label>

              <EmployeeMultiSelect
                value={optionalIds}
                onChange={setOptional}
                excludeIds={[organizerEmployeeId]}
                label="Optional participants"
                testId="optional-participants"
                otherIds={attendeeIds}
                otherLabel="Participants"
                onMoveHere={(id) => {
                  setAttendeeIds((current) => current.filter((v) => v !== id));
                  setOptionalIds((current) => [...current, id]);
                }}
                onMoveOut={(id) => {
                  setOptionalIds((current) => current.filter((v) => v !== id));
                  setAttendeeIds((current) => [...current, id]);
                }}
              />

            </div>

          </div>

          <p className="mt-2 text-sm text-gray-500">
            The organizer is automatically included in the meeting.
          </p>

          {participantNumber > roomCapacity && (
            <p
              role="status"
              data-testid="capacity-warning"
              className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800"
            >
              <span className="font-semibold">Over capacity.</span> This room
              seats {roomCapacity} and you have {participantNumber} people. You
              can still book it.
            </p>
          )}

        </div>

        {/* Start */}

        <div>

          <Label>
            Start Time
          </Label>

          <TimeSelect
            value={startTime}
            onChange={setStartTime}
            placeholder="Select start time"
          />

        </div>

        {/* End */}

        <div>

          <Label>
            End Time
          </Label>

          <TimeSelect
            value={endTime}
            onChange={setEndTime}
            after={startTime || undefined}
            placeholder="Select end time"
          />

        </div>

        {slotError && (
          <p className="text-sm font-medium text-red-600 md:col-span-2" role="alert" data-testid="slot-error">
            {slotError}
          </p>
        )}

      </div>

      {/* Booked slots for the chosen date. Bookings the chosen meeting type
          outranks are listed apart: the room can be taken over from them. */}

      <div className="mt-6" data-testid="booked-slots">

        <Label>
          Booked Time Slots
        </Label>

        {meetingDate === "" ? (

          <p className="mt-2 text-sm text-gray-500">
            Select a date to view booked slots.
          </p>

        ) : slotsLoading ? (

          <p className="mt-2 text-sm text-gray-500">
            Checking the room...
          </p>

        ) : bookedSlots.length === 0 ? (

          <p className="mt-2 rounded-lg bg-green-50 p-3 text-green-700">
            Room is available for the entire day.
          </p>

        ) : (

          <>

          <button
            type="button"
            onClick={() => setSlotsOpen((open) => !open)}
            aria-expanded={slotsOpen}
            aria-controls="booked-slots-list"
            className="mt-2 flex w-full items-center justify-between rounded-lg border bg-red-50 px-4 py-2 text-left text-sm font-medium text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>
              {bookedSlots.length} booked slot
              {bookedSlots.length === 1 ? "" : "s"} on this date
            </span>
            <ChevronDown
              className={`size-4 shrink-0 transition-transform ${
                slotsOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          <div
            id="booked-slots-list"
            hidden={!slotsOpen}
            className="mt-2 max-h-60 space-y-4 overflow-y-auto overscroll-contain rounded-lg border p-2"
          >

            {fixedSlots.length > 0 && (
              <div className="space-y-2">
                {fixedSlots.map((slot, index) => (
                  <div
                    key={index}
                    className="rounded-lg bg-red-50 px-4 py-3 text-red-700"
                  >
                    <p className="font-semibold">
                      {slot.startTime.slice(0, 5)} - {slot.endTime.slice(0, 5)}
                    </p>
                    <p className="text-sm">
                      {slot.title} · {slot.meetingTypeName}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {takeoverSlots.length > 0 && (
              <div className="space-y-2" data-testid="takeover-slots">
                <p className="text-sm font-medium text-amber-800">
                  Lower priority than {selectedType?.meetingTypeName} - you can
                  take these slots
                </p>
                {takeoverSlots.map((slot, index) => (
                  <div
                    key={index}
                    className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
                  >
                    <p className="font-semibold">
                      {slot.startTime.slice(0, 5)} - {slot.endTime.slice(0, 5)}
                    </p>
                    <p className="text-sm">
                      {slot.title} · {slot.meetingTypeName}
                    </p>
                  </div>
                ))}
              </div>
            )}

          </div>

          </>

        )}

      </div>

      <div className="mt-10 space-y-6">

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

        {/* Recurrence */}

        <div>

          <div className="flex items-center gap-2">

            <Checkbox
              id="isRecurring"
              checked={isRecurring && policy.canBookRecurring}
              disabled={!policy.canBookRecurring}
              onCheckedChange={(checked) =>
                setIsRecurring(checked === true)
              }
            />

            <Label htmlFor="isRecurring" className="cursor-pointer">
              Make this a recurring meeting
            </Label>

            {!policy.canBookRecurring && (
              <span className="text-sm text-gray-500" data-testid="recurring-not-allowed">
                (not available to your group)
              </span>
            )}

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
                  max={occurrenceLimit}
                  step={1}
                  value={occurrenceCount}
                  // A wheel over a focused number input changes its value;
                  // drop focus first so scrolling the page never does.
                  onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) =>
                    setOccurrenceCount(e.target.value)
                  }
                />

                <p className="mt-2 text-sm text-gray-500">
                  Up to {occurrenceLimit} occurrences.
                </p>

              </div>

            </div>

          )}

        </div>

      </div>

      <Button
  className="mt-10 w-full"
  onClick={() => handleSubmit()}
  disabled={loading}
>
  {loading
    ? "Scheduling..."
    : "Confirm Booking"}
</Button>

      {/* The chosen meeting type outranks everything in the way: confirm before
          those meetings are put on hold for their organizers to reschedule (and
          cancelled automatically if they do not). */}
      <AlertDialog open={confirmTakeover} onOpenChange={setConfirmTakeover}>
        <AlertDialogContent data-testid="takeover-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Take this room from lower-priority meetings?
            </AlertDialogTitle>

            <AlertDialogDescription>
              {selectedType?.meetingTypeName} has a higher priority than the
              booking{overlapping.length === 1 ? "" : "s"} below. Confirming
              takes the room now. The organizer
              {overlapping.length === 1 ? " is" : "s are"} e-mailed to change
              the room or time; otherwise the meeting
              {overlapping.length === 1 ? " is" : "s are"} cancelled
              automatically 30 minutes before {overlapping.length === 1 ? "it starts" : "they start"}.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            {overlapping.map((slot, index) => (
              <div
                key={index}
                className="rounded-lg border bg-slate-50 p-3 text-sm"
              >
                <p className="font-semibold">
                  {slot.startTime.slice(0, 5)} - {slot.endTime.slice(0, 5)}
                </p>
                <p>{slot.title} · {slot.meetingTypeName}</p>
              </div>
            ))}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>

            <Button
              onClick={() => {
                setConfirmTakeover(false);
                void handleSubmit(true);
              }}
              data-testid="confirm-takeover"
            >
              Take the room and book
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={seriesConflict !== null}
        onOpenChange={(open) => {
          if (!open && !loading) setSeriesConflict(null);
        }}
      >
        <AlertDialogContent
          data-testid="series-conflict-dialog"
          className="sm:w-[min(64rem,calc(100vw-4rem))] sm:max-w-none"
        >
          {seriesConflict && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Room is not free for the whole series
                </AlertDialogTitle>

                {/* Short on purpose: the rows say the rest. */}
                <AlertDialogDescription>
                  {seriesConflict.dates.length - seriesConflict.conflicts.length} of{" "}
                  {seriesConflict.dates.length} dates free,{" "}
                  {seriesConflict.conflicts.length} booked. Nothing is booked yet. Book the free dates, or change the room, date or time.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <ul className="space-y-2 text-sm">
                {seriesConflict.dates.map((date, index) => {
                  const taken = seriesConflict.conflicts.includes(date);

                  return (
                    <li
                      key={date}
                      data-testid="series-date-row"
                      className={`flex items-center justify-between rounded-md border px-3 py-2 ${
                        taken
                          ? "border-red-200 bg-red-50 text-red-900"
                          : "border-green-200 bg-green-50 text-green-800"
                      }`}
                    >
                      <span>
                        {index + 1}. {formatSeriesDate(date)}
                      </span>
                      <span className="font-medium">
                        {taken ? "Booked" : "Available"}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {/* Two groups: quiet ways out on the left, the two real actions on the
                  right. On a phone they stack, the actions first. */}
              <AlertDialogFooter className="sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1 sm:flex-row sm:gap-1">
                  {/* The room is fixed on this page, so picking another room
                      means going back to the step that chose it (the
                      available-rooms list or the room's booking form, which
                      both restore what was entered). */}
                  <AlertDialogCancel
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={goBackToChange}
                    className="justify-start text-gray-600 sm:justify-center"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Different room
                  </AlertDialogCancel>

                  <AlertDialogCancel
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={() => {
                      toast.info("Change the date or time above.");
                    }}
                    className="justify-start text-gray-600 sm:justify-center"
                  >
                    <CalendarClock className="h-4 w-4" />
                    Change date or time
                  </AlertDialogCancel>
                </div>

                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  {seriesConflict.dates.length > seriesConflict.conflicts.length && (
                    <Button size="lg" onClick={bookAvailableDates} disabled={loading}>
                      <CalendarCheck className="h-4 w-4" />
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
                </div>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
