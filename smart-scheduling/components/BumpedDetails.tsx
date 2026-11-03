// Who took a bumped booking's room, and the meeting that replaced it. The
// bumped booking's own details stay as they were; this only adds the "why".
export type BumpDetails = {
  byName: string;
  byGroup: string | null;
  title: string;
  meetingType: string;
  roomName: string;
  meetingDate: string;
  startTime: string;
  endTime: string;
  reason: string;
};

export default function BumpedDetails({ bump }: { bump: BumpDetails }) {
  return (
    <div
      className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm"
      data-testid="bumped-details"
    >
      <p className="font-semibold text-orange-900">
        Replaced by {bump.byName}
        {bump.byGroup ? ` (${bump.byGroup})` : ""}
      </p>

      <p className="mt-1 text-orange-900">
        A higher-priority booking took this room. This booking is kept here for
        reference and no longer holds the room.
      </p>

      <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-orange-800">
        Replacement meeting
      </h3>

      <dl className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">Title: </dt>
          <dd className="inline">{bump.title}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Type: </dt>
          <dd className="inline">{bump.meetingType}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Room: </dt>
          <dd className="inline">{bump.roomName}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Date: </dt>
          <dd className="inline">{bump.meetingDate}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Time: </dt>
          <dd className="inline">
            {bump.startTime.slice(0, 5)} - {bump.endTime.slice(0, 5)}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline font-medium">Reason: </dt>
          <dd className="inline">{bump.reason}</dd>
        </div>
      </dl>
    </div>
  );
}
