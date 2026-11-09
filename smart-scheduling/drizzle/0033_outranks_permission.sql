-- Two permissions a group can be given for meetings that invite one of its
-- members (required or optional):
--   booking.outranks  - the meeting always gets the room, whatever its type;
--   booking.protected - the meeting can never be taken over by any booking.
-- Every group gets both rows; only Leadership has them switched on, so nobody
-- else is affected.
INSERT INTO "group_permissions" ("group_id", "permission_key", "is_enabled")
SELECT g."id", p."key", lower(g."name") = 'leadership'
FROM "groups" g
CROSS JOIN (VALUES ('booking.outranks'), ('booking.protected')) AS p("key")
ON CONFLICT DO NOTHING;
