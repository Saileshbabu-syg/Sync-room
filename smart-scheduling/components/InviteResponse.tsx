"use client";

import { useState } from "react";
import { CalendarDays, Check, Clock, DoorOpen, User, X } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  info: {
    title: string;
    organizer: string;
    room: string;
    date: string;
    start: string;
    end: string;
    participant: string;
  };
  credentials: { meetingId: number; employeeId: number; token: string };
  // The button the person clicked in the e-mail, shown as the suggested answer.
  initialAction: "accept" | "decline";
};

export default function InviteResponse({
  info,
  credentials,
  initialAction,
}: Props) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [done, setDone] = useState<"ACCEPTED" | "DECLINED" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (action: "accept" | "decline") => {
    setBusy(action);
    setError(null);

    try {
      const response = await fetch("/api/invitations/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials, action }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        setDone(data.response);
      } else {
        setError(data.message ?? "Something went wrong.");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const rows = [
    { icon: User, label: "Organizer", value: info.organizer },
    { icon: DoorOpen, label: "Room", value: info.room },
    { icon: CalendarDays, label: "Date", value: info.date },
    { icon: Clock, label: "Time", value: `${info.start} - ${info.end}` },
  ];

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow">
        {done ? (
          <div className="text-center" role="status">
            <div
              className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
                done === "ACCEPTED"
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {done === "ACCEPTED" ? <Check /> : <X />}
            </div>
            <h1 className="mt-4 text-xl font-bold">
              {done === "ACCEPTED" ? "Invitation accepted" : "Invitation declined"}
            </h1>
            <p className="mt-2 text-gray-600">
              Your response to &quot;{info.title}&quot; has been recorded. You
              can close this page.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500">Hi {info.participant},</p>
            <h1 className="mt-1 text-xl font-bold">{info.title}</h1>

            <ul className="mt-5 space-y-3 text-sm">
              {rows.map(({ icon: Icon, label, value }) => (
                <li key={label} className="flex items-center gap-3">
                  <Icon className="h-4 w-4 text-blue-600" />
                  <span className="w-20 text-gray-500">{label}</span>
                  <span className="font-medium">{value}</span>
                </li>
              ))}
            </ul>

            <p className="mt-6 text-sm text-gray-600">
              Please confirm your answer. It can only be given once.
            </p>

            {error && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-3">
              <Button
                className="flex-1 bg-green-600 hover:bg-green-700"
                variant={initialAction === "accept" ? "default" : "outline"}
                disabled={busy !== null}
                onClick={() => void respond("accept")}
              >
                {busy === "accept" ? "Saving..." : "Accept"}
              </Button>
              <Button
                className="flex-1"
                variant={initialAction === "decline" ? "destructive" : "outline"}
                disabled={busy !== null}
                onClick={() => void respond("decline")}
              >
                {busy === "decline" ? "Saving..." : "Decline"}
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
