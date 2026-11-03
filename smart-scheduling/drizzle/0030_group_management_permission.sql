-- Group Management becomes a permission a group can be given (group.manage).
-- Every group gets the row; only the Admin group has it switched on, so nobody
-- gains access. The Admin role keeps access regardless (see canManageGroups).
INSERT INTO "group_permissions" ("group_id", "permission_key", "is_enabled")
SELECT g."id", 'group.manage', lower(g."name") = 'admin'
FROM "groups" g
ON CONFLICT DO NOTHING;
