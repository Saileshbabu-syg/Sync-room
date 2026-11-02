import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/db";
import {
  employee,
  meeting,
  room,
  room_request_emails,
  room_request_holders,
  room_requests,
} from "@/db/schema";
import {
  APP_TIMEZONE,
  MAX_DELIVERY_ATTEMPTS,
  MEETING_STATUS,
} from "@/lib/constants";
import type { DbExecutor } from "@/lib/db-types";

import { sendNoticeEmail } from "./email.service";

// E-mail for room requests goes through `room_request_emails`, an outbox like
// the one for meeting e-mails:
//   1. the transaction that changes the request inserts a PENDING row (so the
//      intent commits, or rolls back, together with the change);
//   2. after commit, dispatchRoomRequestEmails() sends it in the background;
//   3. rows that failed stay PENDING and are retried by the cron job up to
//      MAX_DELIVERY_ATTEMPTS, then parked as FAILED with a short safe reason.
// (request, kind, recipient) is unique, so a retry, a double click or two
// instances can never send the same mail twice. The address and the text are
// read from the database when sending; nothing comes from the client. A
// request can concern several organizers (one per booked meeting in the way),
// so organizer e-mails are queued once per organizer.

export type RoomRequestEmailKind =
  | "SUBMITTED" //         -> an organizer whose meeting is in the way
  | "AWAITING_RELEASE" //  -> an organizer: everyone agreed, their booking still holds the room
  | "APPROVAL_PENDING" //  -> the requester: everyone agreed in principle, not booked yet
  | "APPROVED" //          -> the requester: booked
  | "REJECTED" //          -> the requester
  | "CANCELLED" //         -> an organizer: the requester took the request back
  | "EXPIRED" //           -> the requester
  | "FAILED"; //           -> the requester: could not be booked

// Returns the new row's id, or undefined when this kind was already queued for
// this recipient.
export async function queueRoomRequestEmail(
  executor: DbExecutor,
  requestId: number,
  kind: RoomRequestEmailKind,
  recipientEmployeeId: number
): Promise<number | undefined> {
  const [row] = await executor
    .insert(room_request_emails)
    .values({
      room_request_id: requestId,
      kind,
      recipient_employee_id: recipientEmployeeId,
    })
    .onConflictDoNothing()
    .returning({ id: room_request_emails.room_request_email_id });

  return row?.id;
}

export type RoomRequestDeliveryResult = "SENT" | "RETRY" | "FAILED" | "SKIPPED";

const requesterEmployee = alias(employee, "requester_employee");
const recipient = alias(employee, "recipient");
const decider = alias(employee, "decider");

const whenFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

function link(label: string, path: string) {
  const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, "");

  return base ? [{ label, url: `${base}${path}` }] : [];
}

// Everything is shown in the application's timezone, the same as the rest of
// the app and its other e-mails.
const slotText = (date: string, start: string, end: string) =>
  `${date}, ${start} - ${end} (${APP_TIMEZONE})`;

export async function deliverRoomRequestEmail(
  emailId: number
): Promise<RoomRequestDeliveryResult> {
  return db.transaction(async (tx) => {
    // Claimed with SKIP LOCKED: the immediate send and the cron retry (or two
    // instances) cannot both send it.
    const [row] = await tx
      .select()
      .from(room_request_emails)
      .where(
        and(
          eq(room_request_emails.room_request_email_id, emailId),
          eq(room_request_emails.status, "PENDING")
        )
      )
      .for("update", { skipLocked: true });

    if (!row) return "SKIPPED" as const;

    const fail = async (reason: string) => {
      await tx
        .update(room_request_emails)
        .set({
          status: "FAILED",
          attempts: row.attempts + 1,
          last_error: reason,
        })
        .where(eq(room_request_emails.room_request_email_id, emailId));

      return "FAILED" as const;
    };

    const [r] = await tx
      .select({
        id: room_requests.room_request_id,
        roomId: room_requests.room_id,
        status: room_requests.status,
        title: room_requests.title,
        message: room_requests.message,
        rejectionReason: room_requests.rejection_reason,
        date: room_requests.meeting_date,
        start: room_requests.start_time,
        end: room_requests.end_time,
        createdAt: room_requests.created_at,
        resultingMeetingId: room_requests.resulting_meeting_id,
        roomName: room.room_name,
        requesterName: requesterEmployee.employee_name,
        requesterEmail: requesterEmployee.email,
        deciderName: decider.employee_name,
      })
      .from(room_requests)
      .innerJoin(room, eq(room.room_id, room_requests.room_id))
      .innerJoin(
        requesterEmployee,
        eq(requesterEmployee.employee_id, room_requests.requester_employee_id)
      )
      .leftJoin(
        decider,
        eq(decider.employee_id, room_requests.decided_by_employee_id)
      )
      .where(eq(room_requests.room_request_id, row.room_request_id));

    const [to] = await tx
      .select({ email: recipient.email, name: recipient.employee_name })
      .from(recipient)
      .where(eq(recipient.employee_id, row.recipient_employee_id));

    if (!r || !to) return fail("request or recipient no longer exists");

    // The booked meetings in the way: this recipient's own (for organizer
    // mails), and how many people must agree in total.
    const holders = await tx
      .select({
        meetingId: room_request_holders.holder_meeting_id,
        organizerId: room_request_holders.organizer_employee_id,
        title: meeting.title,
        start: meeting.start_time,
        end: meeting.end_time,
        meetingStatusId: meeting.meetingStatusId,
        roomId: meeting.room_id,
      })
      .from(room_request_holders)
      .innerJoin(meeting, eq(meeting.meeting_id, room_request_holders.holder_meeting_id))
      .where(eq(room_request_holders.room_request_id, r.id))
      .orderBy(asc(meeting.start_time));

    const organizerIds = new Set(holders.map((h) => h.organizerId));
    const mine = holders.filter((h) => h.organizerId === row.recipient_employee_id);
    // Still holding the requested room.
    const stillHolding = mine.filter(
      (h) => h.meetingStatusId !== MEETING_STATUS.CANCELLED && h.roomId === r.roomId
    );

    const meetingLines = (list: typeof mine) =>
      list.map(
        (h) => `Your booking: "${h.title}", ${slotText(r.date, h.start, h.end)}`
      );

    const slot = slotText(r.date, r.start, r.end);
    const reviewPath = `/requests/${r.id}`;
    const kind = row.kind as RoomRequestEmailKind;

    let subject: string;
    let lines: string[];
    let links: { label: string; url: string }[] = [];

    switch (kind) {
      case "SUBMITTED":
        subject = `Room Request: ${r.roomName} — ${r.date}`;
        lines = [
          `${r.requesterName} (${r.requesterEmail}) has asked to use ${r.roomName}, which you have booked, because they have an important meeting.`,
          `Requested slot: ${slot}`,
          ...meetingLines(mine),
          `Their message: ${r.message}`,
          `Sent: ${whenFormat.format(r.createdAt ?? new Date())} (${APP_TIMEZONE}). Request #${r.id}, status: ${r.status}.`,
          ...(organizerIds.size > 1
            ? [
                `${organizerIds.size - 1} other organizer(s) also have a booking in that room at that time. The request only goes ahead when every one of you agrees, and the room is free.`,
              ]
            : []),
          "Nothing changes until you decide. Open the request, sign in, and confirm Approve or Reject there. Your booking is never cancelled unless you choose that explicitly.",
        ];
        links = [
          ...link("Approve Request", `${reviewPath}?intent=approve`),
          ...link("Reject Request", `${reviewPath}?intent=reject`),
          ...link("Review this request", reviewPath),
        ];
        break;

      case "AWAITING_RELEASE":
        subject = `Room request approved, waiting for your booking — ${r.roomName}`;
        lines = [
          `Everyone agreed to ${r.requesterName}'s request for ${r.roomName} (${slot}).`,
          ...meetingLines(stillHolding),
          "That booking still holds the room, so the new booking has NOT been made yet.",
          "To finish, cancel it yourself or release it from the request page. The requested meeting is booked automatically once every booking in the way is gone.",
        ];
        links = link("Open the request", reviewPath);
        break;

      case "APPROVAL_PENDING":
        subject = `Room request agreed, not booked yet — ${r.roomName}`;
        lines = [
          `Everyone you asked agreed to your request for ${r.roomName} (${slot}), but the room is still held by an existing booking.`,
          "Your meeting is not booked yet. It will be booked automatically as soon as the room is free, and you will get another e-mail then.",
        ];
        links = link("Track your request", reviewPath);
        break;

      case "APPROVED":
        subject = `Room request approved and booked — ${r.roomName}`;
        lines = [
          `Your request was approved and your meeting is booked.`,
          `Meeting: "${r.title}"`,
          `Room: ${r.roomName}`,
          `When: ${slot}`,
        ];
        links = link(
          "View your booking",
          r.resultingMeetingId ? `/bookings/${r.resultingMeetingId}` : reviewPath
        );
        break;

      case "REJECTED":
        subject = `Room request rejected — ${r.roomName}`;
        lines = [
          `${r.deciderName ?? "An organizer"} did not approve your request for ${r.roomName} (${slot}).`,
          ...(r.rejectionReason ? [`Reason: ${r.rejectionReason}`] : []),
          "The room stays with the existing booking(s). You can choose another room or time.",
        ];
        links = link("Open the request", reviewPath);
        break;

      case "CANCELLED":
        subject = `Room request withdrawn — ${r.roomName}`;
        lines = [
          `${r.requesterName} withdrew their request for ${r.roomName} (${slot}). No action is needed; your booking is unchanged.`,
        ];
        break;

      case "EXPIRED":
        subject = `Room request expired — ${r.roomName}`;
        lines = [
          `Your request for ${r.roomName} (${slot}) was not completed before the meeting time, so it expired.`,
          "Nothing was booked for you.",
        ];
        break;

      case "FAILED":
        subject = `Room request could not be booked — ${r.roomName}`;
        lines = [
          `Everyone agreed to your request for ${r.roomName} (${slot}), but the booking could not be made (for example the room is out of service). Nothing was booked.`,
        ];
        break;
    }

    try {
      await sendNoticeEmail(to.email, subject, lines, links);

      await tx
        .update(room_request_emails)
        .set({
          status: "SENT",
          sent_at: new Date(),
          attempts: row.attempts + 1,
          last_error: null,
        })
        .where(eq(room_request_emails.room_request_email_id, emailId));

      return "SENT" as const;
    } catch (error) {
      // Log the detail, store only a short, safe reason.
      console.error(
        `Room request e-mail ${emailId} (${kind}) failed:`,
        error instanceof Error ? error.message : error
      );

      const code =
        typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "error";

      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;

      await tx
        .update(room_request_emails)
        .set({
          attempts,
          status: exhausted ? "FAILED" : "PENDING",
          last_error: `delivery failed (${code})`,
        })
        .where(eq(room_request_emails.room_request_email_id, emailId));

      return (exhausted ? "FAILED" : "RETRY") as RoomRequestDeliveryResult;
    }
  });
}

// Fire-and-forget after the transaction has committed. Never throws.
export function dispatchRoomRequestEmails(ids: (number | undefined)[]) {
  for (const id of ids) {
    if (id === undefined) continue;

    void deliverRoomRequestEmail(id).catch((error) => {
      console.error(
        `Room request e-mail ${id} dispatch error:`,
        error instanceof Error ? error.message : error
      );
    });
  }
}

// Cron retry pass for rows the immediate attempt did not finish. A manual
// retry is the same thing: run it again.
export async function processPendingRoomRequestEmails(
  minAgeSeconds = 30,
  limit = 50
) {
  const due = await db
    .select({ id: room_request_emails.room_request_email_id })
    .from(room_request_emails)
    .where(
      and(
        eq(room_request_emails.status, "PENDING"),
        sql`${room_request_emails.created_at} <= now() - make_interval(secs => ${minAgeSeconds})`,
        sql`${room_request_emails.attempts} < ${MAX_DELIVERY_ATTEMPTS}`
      )
    )
    .orderBy(asc(room_request_emails.room_request_email_id))
    .limit(limit);

  const summary: Record<RoomRequestDeliveryResult, number> = {
    SENT: 0,
    RETRY: 0,
    FAILED: 0,
    SKIPPED: 0,
  };

  for (const { id } of due) {
    summary[await deliverRoomRequestEmail(id)]++;
  }

  return summary;
}
