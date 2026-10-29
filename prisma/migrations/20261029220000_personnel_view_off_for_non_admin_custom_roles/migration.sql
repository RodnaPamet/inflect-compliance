-- Owner decision, 2026-10-29: only Owners and Admins read the people layer
-- (the employee roster, devices, training assignments and background checks).
--
-- `getPermissionsForRole` already stops granting `personnel.view` to EDITOR,
-- AUDITOR and READER (#4503). That change reaches built-in roles, and custom
-- roles whose stored `permissionsJson` has no `personnel` domain, because
-- `parsePermissionsJson` fills a missing domain from the base role's defaults.
-- It does not reach a custom role that STATES the key. `validatePermissionsJson`
-- requires every action of every domain on create and update, so every role
-- saved since the people layer existed states `personnel.view`, and a role
-- built from the Reader, Editor or Auditor preset before #4503 states it as
-- `true`. This migration switches those grants off, once.
--
-- SCOPE, row by row:
--   - `baseRole` READER, EDITOR or AUDITOR, AND a stored `personnel.view` that
--     is the JSON boolean `true`. Only that one key changes; `jsonb_set` leaves
--     every other key of the blob as it was. `updatedAt` is stamped, so the row
--     says when it last changed.
--   - ADMIN-based roles are left alone: ADMIN keeps the read.
--   - OWNER and AI_ADMIN are never a custom role's base (CHECK
--     "TenantCustomRole_base_role_not_built_in_scope", #3734). The base filter
--     is an allowlist, not `<> 'ADMIN'`, on purpose: where that CHECK was left
--     NOT VALID over a legacy OWNER- or AI_ADMIN-based row, the CHECK still
--     refuses any UPDATE of that row that keeps its base, and one refused row
--     would fail this migration and the deploy.
--   - `personnel.manage` is left alone.
--   - A row with no `personnel` domain, or a non-boolean `view`, is left
--     alone: it already reads its base role's default, which #4503 makes
--     `false` for these three bases.
--   - Inactive (soft-deleted) rows are included, so a row brought back later
--     does not bring the grant back with it.
--
-- A pure data UPDATE: no DDL, and no lock that blocks other readers or writers
-- of the table beyond the rows it changes. It is idempotent: a changed row no
-- longer matches, so a re-run changes nothing.
-- Safe in either order against a rolling deploy: an old container reads the
-- updated blob as a valid permission set whose `personnel.view` is `false`.
--
-- No audit row is written. The audit trail is hash-chained, and its entries are
-- appended only through the application's `logEvent`, never from SQL.
--
-- FORWARD-ONLY. To give a role the read back, an Admin ticks Personnel / view
-- for that role on the Roles page, which writes CUSTOM_ROLE_UPDATED.

UPDATE "TenantCustomRole"
   SET "permissionsJson" = jsonb_set("permissionsJson", '{personnel,view}', 'false'::jsonb, false),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
   AND "permissionsJson" -> 'personnel' -> 'view' = 'true'::jsonb;
