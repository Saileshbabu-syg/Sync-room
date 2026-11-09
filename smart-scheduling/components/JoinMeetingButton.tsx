import { Video } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  joinUrl: string;
  variant?: "default" | "outline";
};

// "Join Meeting" for an online (Microsoft Teams) meeting. The link is only
// ever handed to people who may see the meeting (organizer, attendees, Admin).
export default function JoinMeetingButton({
  joinUrl,
  variant = "default",
}: Props) {
  return (
    <Button asChild variant={variant} data-testid="join-meeting">
      <a href={joinUrl} target="_blank" rel="noopener noreferrer">
        <Video className="h-4 w-4" />
        Join Meeting
      </a>
    </Button>
  );
}

export function TeamsBadge() {
  return (
    <span
      className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700"
      data-testid="teams-badge"
    >
      Microsoft Teams
    </span>
  );
}
