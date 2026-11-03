import { isValidInvitationToken } from "@/lib/invitation-token";
import { parseIdParam } from "@/lib/api";
import {
  getInvitationInfo,
  RESPONSE,
  RESPONSE_LABEL,
} from "@/lib/services/invitation.service";

import InviteResponse from "@/components/InviteResponse";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow">
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="mt-2 text-gray-600">{body}</p>
      </div>
    </main>
  );
}

// Opened from the Accept / Decline buttons in the invitation e-mail. Nothing is
// saved by opening it: the person confirms with a click, so mail scanners that
// follow links cannot answer for them.
export default async function InvitePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const meetingId = parseIdParam(first(params.m));
  const employeeId = parseIdParam(first(params.e));
  const token = first(params.t) ?? "";
  const action = first(params.a) === "decline" ? "decline" : "accept";

  if (
    meetingId === null ||
    employeeId === null ||
    !isValidInvitationToken(meetingId, employeeId, token)
  ) {
    return (
      <Message
        title="Invitation link not valid"
        body="This link is incomplete or has been changed. Please use the buttons in your invitation e-mail."
      />
    );
  }

  const info = await getInvitationInfo(meetingId, employeeId);

  if (!info) {
    return (
      <Message
        title="Invitation link not valid"
        body="You are no longer invited to this meeting."
      />
    );
  }

  if (info.closedReason) {
    return <Message title="Meeting unavailable" body={info.closedReason} />;
  }

  if (info.response !== RESPONSE.NONE) {
    return (
      <Message
        title="Already answered"
        body={`Your response to this invitation was recorded as "${RESPONSE_LABEL[info.response]}". It cannot be changed.`}
      />
    );
  }

  return (
    <InviteResponse
      info={{
        title: info.meetingTitle,
        organizer: info.organizerName,
        room: info.roomName,
        date: info.meetingDate,
        start: info.startTime.slice(0, 5),
        end: info.endTime.slice(0, 5),
        participant: info.participantName,
      }}
      credentials={{ meetingId, employeeId, token }}
      initialAction={action}
    />
  );
}
