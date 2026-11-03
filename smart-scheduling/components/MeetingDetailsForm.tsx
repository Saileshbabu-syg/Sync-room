"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CalendarCheck,
  CalendarClock,
  ChevronDown,
  Send,
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

// What the booking screen is told when the chosen room is taken.
type SlotConflict =
  | {
      requestable: true;
      // Every booking in the way (usually one; several organizers are asked
      // when there are more).
      bookings: {
        roomName: string;
        meetingDate: string;
        startTime: string;
        endTime: string;
        organizerName: string;
        title: string | null;
      }[];
    }
  | { requestable: false; reason: string; code?: string };

// What is known about one booked date of a series before anything is sent.
type DateInfo =
  | { state: "requestable"; organizers: string[]; titles: string[] }
  | { state: "blocked"; code?: string; reason: string };

// Outcome of asking for one booked date of a series.
type RequestedDate = { ok: boolean; message?: string };

const REQUEST_MESSAGE_MAX = 1000;

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

  // The selected room is taken for the chosen time (single booking).
  const [slotConflict, setSlotConflict] = useState<SlotConflict | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestMessage, setRequestMessage] = useState("");
  // One key per request form, so a double click or a retry cannot send two.
  const [clientRequestId, setClientRequestId] = useState("");

  // Recurring series: the booked dates the user has ticked to request (none
  // by default), the reason written for each, which dropdown is open (only one
  // at a time), what has already been asked for, and one stable key per date
  // so a retry never sends a date twice.
  const [selectedRequestDates, setSelectedRequestDates] = useState<string[]>([]);
  const [dateMessages, setDateMessages] = useState<Record<string, string>>({});
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [showMessageErrors, setShowMessageErrors] = useState(false);
  const [requested, setRequested] = useState<Record<string, RequestedDate>>({});
  const seriesRequestKeys = useRef<Record<string, string>>({});
  const sendingSeries = useRef(false);
  // Each booked date of the series, checked as soon as the dialog opens, so the
  // user is told up front which can be requested and why the others cannot.
  const [dateInfo, setDateInfo] = useState<Record<string, DateInfo | "checking">>({});

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
        : null;

  // The headcount is the attendees plus the organizer, who is added
  // automatically.
  const participantNumber = attendeeIds.length + 1;

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

// Recurring series. Each booked date is checked as soon as the dialog opens
// (who holds it, or why it cannot be requested) and shown as a dropdown; only
// one is open at a time. The user ticks the dates they want and writes a reason
// for EACH ticked date (a request never goes out without one). One button then
// sends a separate request per ticked date, each to the organizer(s) of that
// date's booking. The free dates are booked with the other button; each
// requested date is booked automatically, later, once its organizer(s) approve
// and the room is free.
const requestableDate = (date: string) => {
  const info = dateInfo[date];

  return info !== undefined && info !== "checking" && info.state === "requestable";
};

// Ticked, still requestable, not already asked for.
const datesToRequest = seriesConflict
  ? seriesConflict.conflicts.filter(
      (date) =>
        selectedRequestDates.includes(date) &&
        requestableDate(date) &&
        requested[date] === undefined
    )
  : [];

// Every booked date that could be ticked.
const tickableDates = seriesConflict
  ? seriesConflict.conflicts.filter(
      (date) => requestableDate(date) && requested[date] === undefined
    )
  : [];

const messageOf = (date: string) => (dateMessages[date] ?? "").trim();

// Ticked dates that still have no reason written.
const datesMissingMessage = datesToRequest.filter((date) => messageOf(date) === "");

const conflictKey = seriesConflict ? seriesConflict.conflicts.join(",") : "";

useEffect(() => {
  if (!conflictKey) return;

  let cancelled = false;
  const dates = conflictKey.split(",");

  const check = async () => {
    setDateInfo(Object.fromEntries(dates.map((d) => [d, "checking" as const])));

    const entries = await Promise.all(
      dates.map(async (date): Promise<[string, DateInfo]> => {
        try {
          const query = new URLSearchParams({
            room_id: String(roomId),
            meeting_date: date,
            start_time: startTime,
            end_time: endTime,
          });

          const response = await fetch(`/api/room-requests?${query.toString()}`);
          const body = await response.json();

          if (response.ok && body.conflict?.requestable) {
            const bookings: { organizerName: string; title: string | null }[] =
              body.conflict.bookings;

            return [
              date,
              {
                state: "requestable",
                organizers: [...new Set(bookings.map((b) => b.organizerName))],
                titles: bookings.map((b) => b.title ?? "Private meeting"),
              },
            ];
          }

          return [
            date,
            {
              state: "blocked",
              code: body.conflict?.code,
              reason: body.conflict?.reason ?? body.message ?? "It cannot be requested.",
            },
          ];
        } catch {
          return [date, { state: "blocked", reason: "Could not check this date." }];
        }
      })
    );

    if (!cancelled) setDateInfo(Object.fromEntries(entries));
  };

  void check();

  return () => {
    cancelled = true;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [conflictKey]);

// Ticking a date opens its dropdown (and so closes the one that was open), so
// the reason can be written straight away.
const toggleRequestDate = (date: string, checked: boolean) => {
  setSelectedRequestDates((current) =>
    checked
      ? current.includes(date)
        ? current
        : [...current, date]
      : current.filter((d) => d !== date)
  );

  if (checked) setOpenDate(date);
};

// Only one dropdown is open at a time.
const toggleOpenDate = (date: string) =>
  setOpenDate((current) => (current === date ? null : date));

const setMessageFor = (date: string, value: string) =>
  setDateMessages((current) => ({ ...current, [date]: value }));

// Copies one date's reason to every other ticked date.
const copyMessageToAll = (fromDate: string) => {
  const text = dateMessages[fromDate] ?? "";

  setDateMessages((current) => ({
    ...current,
    ...Object.fromEntries(datesToRequest.map((date) => [date, text])),
  }));
};

const sendSeriesRequests = async () => {
  // A second click while the first batch is still going would double-send.
  // (state updates are async, so a ref is the reliable guard.)
  if (sendingSeries.current) return;

  if (slotError) {
    toast.warning(slotError);
    return;
  }

  if (datesToRequest.length === 0) {
    toast.info("Tick at least one booked date to request.");
    return;
  }

  // A ticked date must have a reason. Show where it is missing and stop.
  if (datesMissingMessage.length > 0) {
    setShowMessageErrors(true);
    setOpenDate(datesMissingMessage[0]);
    toast.warning(
      datesMissingMessage.length === 1
        ? "Write a reason for the ticked date."
        : `Write a reason for each ticked date (${datesMissingMessage.length} missing).`
    );
    return;
  }

  if (datesToRequest.some((date) => messageOf(date).length > REQUEST_MESSAGE_MAX)) {
    toast.warning(`A message can be at most ${REQUEST_MESSAGE_MAX} characters.`);
    return;
  }

  const participantEmployeeIds = attendeeIds;

  sendingSeries.current = true;
  setLoading(true);

  const results: Record<string, RequestedDate> = {};

  try {
    // One at a time, so the organizers' e-mails arrive in date order and one
    // failure does not hide the others.
    for (const date of datesToRequest) {
      // The same key for the same date on a retry, so it is never sent twice.
      seriesRequestKeys.current[date] ??= crypto.randomUUID();

      try {
        const response = await fetch("/api/room-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: meetingTitle,
            meeting_date: date,
            room_id: roomId,
            participant_count: participantNumber,
            meeting_type_id: Number(meetingTypeId),
            start_time: startTime,
            end_time: endTime,
            participantEmployeeIds,
            message: messageOf(date),
            client_request_id: seriesRequestKeys.current[date],
          }),
        });

        const result = await response.json();

        results[date] = response.ok
          ? { ok: true }
          : { ok: false, message: result.message ?? "Could not send the request." };
      } catch {
        results[date] = { ok: false, message: "Could not send the request." };
      }
    }
  } finally {
    sendingSeries.current = false;
    setLoading(false);
  }

  const sent = Object.values(results).filter((r) => r.ok).length;
  const failedDates = Object.keys(results).filter((d) => !results[d].ok);
  const failed = failedDates.length;

  if (sent > 0) {
    toast.success(
      `${sent} request${sent === 1 ? "" : "s"} sent. Nothing is booked for those dates until the organizers agree.`
    );
  }

  if (failed === 0) {
    // Everything went through: close the dialog, forget the series state and
    // reload the server data so the new requests show up.
    setSeriesConflict(null);
    setRequested({});
    setSelectedRequestDates([]);
    setDateMessages({});
    setOpenDate(null);
    setShowMessageErrors(false);
    seriesRequestKeys.current = {};
    router.refresh();
    return;
  }

  // Partial failure: keep the dialog open, mark what failed and open the
  // first failed row so the reason is visible.
  setRequested((current) => ({ ...current, ...results }));
  setSelectedRequestDates((current) => current.filter((d) => results[d] === undefined));
  setShowMessageErrors(false);
  setOpenDate(failedDates[0]);
  // The failed dates keep their idempotency keys, so a retry can never double-send.

  toast.error(
    `${failed} request${failed === 1 ? "" : "s"} could not be sent: ${failedDates
      .map(formatSeriesDate)
      .join(", ")}.`
  );
};

const openRequestForm = () => {
  setClientRequestId(crypto.randomUUID());
  setRequestMessage("");
  setRequestOpen(true);
};

const sendRoomRequest = async () => {
  const message = requestMessage.trim();

  if (slotError) {
    toast.warning(slotError);
    return;
  }

  if (!message) {
    toast.warning("Please explain why you need the room.");
    return;
  }

  if (message.length > REQUEST_MESSAGE_MAX) {
    toast.warning(`The message can be at most ${REQUEST_MESSAGE_MAX} characters.`);
    return;
  }

  const participantEmployeeIds = attendeeIds;

  setLoading(true);

  try {
    const response = await fetch("/api/room-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: meetingTitle,
        meeting_date: meetingDate,
        room_id: roomId,
        participant_count: participantNumber,
        meeting_type_id: Number(meetingTypeId),
        start_time: startTime,
        end_time: endTime,
        participantEmployeeIds,
        message,
        client_request_id: clientRequestId,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      toast.error(result.message ?? "Could not send the request.");
      return;
    }

    sessionStorage.removeItem("bookMeetingForm");
    sessionStorage.removeItem("roomBookingForm");
    toast.success(
      "Request sent. The organizer has been e-mailed. Nothing is booked until they agree and the room is free."
    );
    router.push(`/requests/${result.requestId}`);
  } catch (error) {
    console.error(error);
    toast.error("Something went wrong.");
  } finally {
    setLoading(false);
  }
};

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

    const pending = Object.values(requested).filter((r) => r.ok).length;

    if (pending > 0) {
      toast.info(
        `${pending} room request${pending === 1 ? " is" : "s are"} waiting for the organizers. Track ${pending === 1 ? "it" : "them"} under Room Requests.`
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

  if (participantNumber > roomCapacity) {
    toast.warning(
      `Room capacity is ${roomCapacity} including you, so add at most ${roomCapacity - 1} attendee(s).`
    );
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

  // The room is held by lower-priority meetings that this booking would move
  // or cancel: say so and wait for a yes instead of booking silently.
  if (willTakeOver && !takeoverConfirmed) {
    setConfirmTakeover(true);
    return;
  }

  setLoading(true);

  try {
    const participantEmployeeIds = attendeeIds;

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
              participantNumber,

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
  // Single booking, slot taken: show what is in the way and offer to ask for
  // it. Nothing has been booked.
  if (!isRecurring && response.status === 409 && result.conflict) {
    setSlotConflict(result.conflict);
    return;
  }

  if (isRecurring && Array.isArray(result.conflicts)) {
    if (Array.isArray(result.occurrenceDates)) {
      // A fresh check of a (possibly different) series: forget what was
      // said about the previous one.
      setRequested({});
      setSelectedRequestDates([]);
      setDateMessages({});
      setOpenDate(null);
      setShowMessageErrors(false);
      seriesRequestKeys.current = {};
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

        <div>

          <Label>
            Meeting Date
          </Label>

          <Input
            type="date"
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
            min={todayDate}
            aria-invalid={slotError ? true : undefined}
          />

        </div>

        {/* Attendees */}

        <div>

          <Label>
            Attendees (room capacity {roomCapacity})
          </Label>

          <EmployeeMultiSelect
            value={attendeeIds}
            onChange={setAttendeeIds}
            excludeIds={[organizerEmployeeId]}
          />

          <p
            className={`mt-2 text-sm ${
              participantNumber > roomCapacity
                ? "font-medium text-red-600"
                : "text-gray-500"
            }`}
          >
            You are included automatically: {participantNumber} of{" "}
            {roomCapacity} seats.
          </p>

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
                  // A wheel over a focused number input changes its value;
                  // drop focus first so scrolling the page never does.
                  onWheel={(e) => e.currentTarget.blur()}
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

      {/* The room is taken: show the existing booking, offer to ask for it. */}
      <AlertDialog
        open={slotConflict !== null && !requestOpen}
        onOpenChange={(open) => {
          if (!open) setSlotConflict(null);
        }}
      >
        <AlertDialogContent data-testid="slot-conflict-dialog">
          {slotConflict && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Room unavailable — existing booking found
                </AlertDialogTitle>

                <AlertDialogDescription>
                  {slotConflict.requestable
                    ? slotConflict.bookings.length > 1
                      ? `${slotConflict.bookings.length} bookings overlap the selected time. You can request the room from their organizers; it is booked for you only when every organizer agrees and the room is free.`
                      : "This room is already booked for the selected time. You can request the room from the current organizer."
                    : slotConflict.reason}
                </AlertDialogDescription>
              </AlertDialogHeader>

              {slotConflict.requestable && (
                <div className="space-y-3">
                  {slotConflict.bookings.map((booking, index) => (
                    <dl
                      key={index}
                      className="space-y-1 rounded-lg border bg-slate-50 p-3 text-sm"
                    >
                      <div><dt className="inline font-semibold">Room: </dt><dd className="inline">{booking.roomName}</dd></div>
                      <div><dt className="inline font-semibold">Date: </dt><dd className="inline">{booking.meetingDate}</dd></div>
                      <div><dt className="inline font-semibold">Time: </dt><dd className="inline">{booking.startTime} – {booking.endTime}</dd></div>
                      <div><dt className="inline font-semibold">Organizer: </dt><dd className="inline">{booking.organizerName}</dd></div>
                      <div><dt className="inline font-semibold">Meeting title: </dt><dd className="inline">{booking.title ?? "Private meeting"}</dd></div>
                    </dl>
                  ))}
                </div>
              )}

              <AlertDialogFooter className="sm:flex-wrap">
                <AlertDialogCancel onClick={goBackToChange}>
                  Choose Another Time or Room
                </AlertDialogCancel>

                {slotConflict.requestable && (
                  <Button onClick={openRequestForm} data-testid="request-this-room">
                    Request This Room
                  </Button>
                )}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {/* The request form: the requester explains why they need the room. */}
      <AlertDialog
        open={requestOpen && slotConflict?.requestable === true}
        onOpenChange={(open) => {
          if (!open && !loading) setRequestOpen(false);
        }}
      >
        <AlertDialogContent data-testid="room-request-dialog">
          {slotConflict?.requestable && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Request this room</AlertDialogTitle>

                <AlertDialogDescription>
                  {[...new Set(slotConflict.bookings.map((b) => b.organizerName))].join(", ")}{" "}
                  will be e-mailed. Nothing is booked unless{" "}
                  {slotConflict.bookings.length > 1 ? "every organizer agrees" : "they agree"}{" "}
                  and the room is free.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <dl className="space-y-1 text-sm">
                <div><dt className="inline font-semibold">Room: </dt><dd className="inline">{slotConflict.bookings[0].roomName}</dd></div>
                <div><dt className="inline font-semibold">Requested: </dt><dd className="inline">{meetingDate}, {startTime} – {endTime}</dd></div>
                <div><dt className="inline font-semibold">{slotConflict.bookings.length > 1 ? "Current organizers" : "Current organizer"}: </dt><dd className="inline">{[...new Set(slotConflict.bookings.map((b) => b.organizerName))].join(", ")}</dd></div>
                <div><dt className="inline font-semibold">{slotConflict.bookings.length > 1 ? "Existing meetings" : "Existing meeting"}: </dt><dd className="inline">{slotConflict.bookings.map((b) => b.title ?? "Private meeting").join("; ")}</dd></div>
              </dl>

              <div>
                <Label htmlFor="requestMessage">Why do you need this room? *</Label>

                <textarea
                  id="requestMessage"
                  value={requestMessage}
                  onChange={(e) => setRequestMessage(e.target.value)}
                  maxLength={REQUEST_MESSAGE_MAX}
                  rows={5}
                  required
                  className="mt-2 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  placeholder="Tell the organizer why you need the room"
                />

                <p className="mt-1 text-right text-xs text-gray-500">
                  {requestMessage.length}/{REQUEST_MESSAGE_MAX}
                </p>
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel
                  disabled={loading}
                  onClick={() => setRequestOpen(false)}
                >
                  Cancel
                </AlertDialogCancel>

                <Button
                  onClick={sendRoomRequest}
                  disabled={loading || requestMessage.trim().length === 0}
                  data-testid="send-room-request"
                >
                  {loading ? "Sending..." : "Send Request"}
                </Button>
              </AlertDialogFooter>
            </>
          )}
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
                  {seriesConflict.conflicts.length} booked. Nothing is booked yet.
                </AlertDialogDescription>
              </AlertDialogHeader>

              {tickableDates.length > 1 && (
                <div className="flex items-center justify-end gap-3 text-sm">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => setSelectedRequestDates(tickableDates)}
                  >
                    Tick all
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={loading || selectedRequestDates.length === 0}
                    onClick={() => setSelectedRequestDates([])}
                  >
                    Clear
                  </Button>
                </div>
              )}

              <ul className="space-y-2 text-sm">
                {seriesConflict.dates.map((date, index) => {
                  const taken = seriesConflict.conflicts.includes(date);

                  // Free dates need nothing from the user.
                  if (!taken) {
                    return (
                      <li
                        key={date}
                        className="flex items-center justify-between rounded-md border border-green-200 bg-green-50 px-3 py-2 text-green-800"
                      >
                        <span>
                          {index + 1}. {formatSeriesDate(date)}
                        </span>
                        <span className="font-medium">Available</span>
                      </li>
                    );
                  }

                  const status = requested[date];
                  const info = dateInfo[date];
                  const open = openDate === date;
                  const ticked = selectedRequestDates.includes(date);
                  const canTick =
                    !status?.ok && info !== undefined && info !== "checking" && info.state === "requestable";
                  const missing =
                    showMessageErrors && ticked && canTick && messageOf(date) === "";

                  // What the closed row says.
                  const summary = status?.ok
                    ? "Requested"
                    : status
                      ? "Failed – not sent"
                      : info === undefined || info === "checking"
                        ? "Checking..."
                        : info.state === "blocked"
                          ? info.code === "OWN_BOOKING"
                            ? "Booked by you"
                            : info.code === "ALREADY_REQUESTED"
                              ? "Already requested"
                              : "Cannot request"
                          : `Booked by ${info.organizers.join(", ")}`;

                  return (
                    <li
                      key={date}
                      className={`rounded-md border ${
                        status?.ok
                          ? "border-blue-200 bg-blue-50 text-blue-900"
                          : missing
                            ? "border-red-400 bg-red-50 text-red-900"
                            : "border-red-200 bg-red-50 text-red-900"
                      }`}
                      data-testid="series-date-row"
                    >
                      <div className="flex items-center gap-3 px-3 py-2">
                        <Checkbox
                          checked={ticked && canTick}
                          disabled={loading || !canTick}
                          onCheckedChange={(checked) =>
                            toggleRequestDate(date, checked === true)
                          }
                          aria-label={`Request ${formatSeriesDate(date)}`}
                          data-testid="series-date-tick"
                        />

                        <button
                          type="button"
                          className="flex flex-1 items-center justify-between gap-3 text-left"
                          aria-expanded={open}
                          onClick={() => toggleOpenDate(date)}
                        >
                          <span>
                            {index + 1}. {formatSeriesDate(date)}
                          </span>

                          <span className="flex items-center gap-2 font-medium">
                            <span className="rounded-full bg-white/70 px-2.5 py-0.5 text-xs ring-1 ring-current/15">
                              {summary}
                            </span>
                            <ChevronDown
                              className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
                            />
                          </span>
                        </button>
                      </div>

                      {open && (
                        <div className="space-y-2 border-t border-current/10 px-3 py-3" data-testid="series-date-details">
                          {status && !status.ok && (
                            <p className="font-medium" role="alert" data-testid="series-date-failed">
                              Request failed: {status.message} Tick the date to try again.
                            </p>
                          )}

                          {status?.ok ? (
                            <p>Request sent. Waiting for the organizer to answer.</p>
                          ) : info === undefined || info === "checking" ? (
                            <p>Checking this date...</p>
                          ) : info.state === "blocked" ? (
                            <p data-testid="series-date-blocked">{info.reason}</p>
                          ) : (
                            <>
                              <p>
                                {startTime} – {endTime} · Organizer
                                {info.organizers.length > 1 ? "s" : ""}:{" "}
                                {info.organizers.join(", ")} · {info.titles.join("; ")}
                              </p>

                              {ticked ? (
                                <div className="space-y-1">
                                  <Label htmlFor={`reason-${date}`} className="text-current">
                                    Why do you need the room on this date? *
                                  </Label>

                                  <textarea
                                    id={`reason-${date}`}
                                    value={dateMessages[date] ?? ""}
                                    onChange={(e) => setMessageFor(date, e.target.value)}
                                    maxLength={REQUEST_MESSAGE_MAX}
                                    rows={3}
                                    required
                                    aria-invalid={missing}
                                    disabled={loading}
                                    className="w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                    placeholder="Tell the organizer why you need the room"
                                  />

                                  <div className="flex items-center justify-between text-xs">
                                    {missing ? (
                                      <span className="font-medium text-red-700" role="alert">
                                        A reason is required for this date.
                                      </span>
                                    ) : (
                                      <span />
                                    )}

                                    <span className="flex items-center gap-3">
                                      {datesToRequest.length > 1 && messageOf(date) !== "" && (
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="xs"
                                          className="bg-white text-gray-800"
                                          onClick={() => copyMessageToAll(date)}
                                        >
                                          Use for all ticked dates
                                        </Button>
                                      )}

                                      <span className="text-gray-500">
                                        {(dateMessages[date] ?? "").length}/{REQUEST_MESSAGE_MAX}
                                      </span>
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-xs">Tick the box to request this date.</p>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {Object.values(requested).some((r) => r.ok) && (
                <p className="rounded-md bg-blue-50 p-3 text-sm text-blue-900">
                  Requests sent. Requested dates are booked for you automatically
                  once approved.
                </p>
              )}

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
                  {/* Always there, so the footer does not jump as dates are
                      ticked; it only lights up once something is ticked. */}
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={sendSeriesRequests}
                    disabled={loading || datesToRequest.length === 0}
                    data-testid="send-series-requests"
                  >
                    <Send className="h-4 w-4" />
                    {loading
                      ? "Sending..."
                      : datesToRequest.length === 0
                        ? "Send requests"
                        : `Send ${datesToRequest.length} request${
                            datesToRequest.length === 1 ? "" : "s"
                          }`}
                  </Button>

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
