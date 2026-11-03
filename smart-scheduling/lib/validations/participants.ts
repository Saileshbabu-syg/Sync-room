import { z } from "zod";

// Employee ids invited to a meeting: mandatory participants and optional ones
// are separate lists, and one person can be in only one of them.
export const employeeIdList = z
  .array(z.number().int().positive())
  .max(100);

export const participantFields = {
  participantEmployeeIds: employeeIdList.optional(),
  optionalParticipantEmployeeIds: employeeIdList.optional(),
};

type Lists = {
  participantEmployeeIds?: number[];
  optionalParticipantEmployeeIds?: number[];
};

export function overlappingParticipant({
  participantEmployeeIds = [],
  optionalParticipantEmployeeIds = [],
}: Lists) {
  const mandatory = new Set(participantEmployeeIds);

  return optionalParticipantEmployeeIds.some((id) => mandatory.has(id));
}

export const NOT_BOTH_LISTS_MESSAGE =
  "An employee cannot be both a participant and an optional participant.";
