-- Owner decision, 2026-10-30 (#4536): only a custom role based on ADMIN may
-- hold `personnel.manage`.
--
-- The built-in defaults give `personnel.manage` to OWNER and ADMIN only, and
-- #4520 switched a stored `personnel.view: true` off on custom roles built on
-- READER, EDITOR or AUDITOR. It left `personnel.manage` alone, so a role stored
-- with `manage: true` on one of those bases could still create roster records
-- it could no longer list. `createCustomRole` / `updateCustomRole` now refuse
-- that combination (PERSONNEL_MANAGE_NEEDS_ADMIN_BASE), and this migration
-- switches off the grants already stored, once.
--
-- SCOPE, row by row — the same shape as #4520's migration:
--   - `baseRole` READER, EDITOR or AUDITOR, AND a stored `personnel.manage`
--     that is the JSON boolean `true`. Only that one key changes; `jsonb_set`
--     leaves every other key of the blob as it was. `updatedAt` is stamped.
--   - ADMIN-based roles are left alone: ADMIN may manage the roster.
--   - The base filter is an allowlist, not `<> 'ADMIN'`, for #4520's reason:
--     where the CHECK "TenantCustomRole_base_role_not_built_in_scope" was left
--     NOT VALID over a legacy OWNER- or AI_ADMIN-based row, that row refuses any
--     UPDATE keeping its base, and one refused row would fail the deploy.
--   - `personnel.view` is left alone.
--   - A row with no `personnel` domain, or a non-boolean `manage`, is left
--     alone: it reads its base role's default, which is `false` on these bases.
--   - Inactive (soft-deleted) rows are included.
--
-- A pure data UPDATE: no DDL. Idempotent: a changed row no longer matches.
-- Safe against a rolling deploy: an old container reads the updated blob as a
-- valid permission set whose `personnel.manage` is `false`.
--
-- No audit row is written; the hash-chained trail is appended only through the
-- application's `logEvent`.
--
-- FORWARD-ONLY. To manage the roster, a role is based on Admin and Personnel /
-- manage ticked on the Roles page, which writes CUSTOM_ROLE_UPDATED.

UPDATE "TenantCustomRole"
   SET "permissionsJson" = jsonb_set("permissionsJson", '{personnel,manage}', 'false'::jsonb, false),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
   AND "permissionsJson" -> 'personnel' -> 'manage' = 'true'::jsonb;
