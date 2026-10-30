-- Owner decision, 2026-10-30 (#4581 A): a custom role may hold the admin
-- permissions whose server code asks the Admin tier only when it is based on
-- ADMIN.
--
-- A custom role's base role is what every coarse-tier check reads. A route
-- gated on `admin.manage`, `admin.members`, `admin.owner_management` or
-- `admin.tenant_lifecycle` passed a role granting the key, and the usecase
-- behind it then asked `assertCanAdmin`, which a READER, EDITOR or AUDITOR base
-- does not have: the role was let in and refused, with no AUTHZ_DENIED row.
-- `createCustomRole` / `updateCustomRole` now refuse such a grant
-- (PERMISSION_NEEDS_ADMIN_BASE, `ADMIN_BASE_ONLY_PERMISSIONS` in
-- src/lib/custom-role-admin-base-rule.ts), and this migration switches off the
-- grants already stored, once. `personnel.manage`, on the same list, was
-- switched off by 20261030130000 (#4536).
--
-- SCOPE, row by row — the same shape as #4520's and #4536's migrations:
--   - `baseRole` READER, EDITOR or AUDITOR, AND the stored key is the JSON
--     boolean `true`. One statement per key, so only that key changes and only
--     on rows that grant it; `jsonb_set` leaves every other key of the blob as
--     it was. `updatedAt` is stamped.
--   - ADMIN-based roles are left alone.
--   - The base filter is an allowlist, not `<> 'ADMIN'`: where the CHECK
--     "TenantCustomRole_base_role_not_built_in_scope" was left NOT VALID over a
--     legacy OWNER- or AI_ADMIN-based row, that row refuses any UPDATE keeping
--     its base, and one refused row would fail the deploy.
--   - A row with no `admin` domain, or a non-boolean value, is left alone: it
--     reads its base role's default, which is `false` for all four keys on
--     these bases.
--   - Inactive (soft-deleted) rows are included.
--
-- A pure data UPDATE: no DDL. Idempotent: a changed row no longer matches.
-- Safe against a rolling deploy: an old container reads the updated blob as a
-- valid permission set with the key `false`.
--
-- No audit row is written; the hash-chained trail is appended only through the
-- application's `logEvent`.
--
-- FORWARD-ONLY. To grant one of these, base the role on Admin and tick it on
-- the Roles page, which writes CUSTOM_ROLE_UPDATED.

UPDATE "TenantCustomRole"
   SET "permissionsJson" = jsonb_set("permissionsJson", '{admin,manage}', 'false'::jsonb, false),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
   AND "permissionsJson" -> 'admin' -> 'manage' = 'true'::jsonb;

UPDATE "TenantCustomRole"
   SET "permissionsJson" = jsonb_set("permissionsJson", '{admin,members}', 'false'::jsonb, false),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
   AND "permissionsJson" -> 'admin' -> 'members' = 'true'::jsonb;

UPDATE "TenantCustomRole"
   SET "permissionsJson" = jsonb_set("permissionsJson", '{admin,owner_management}', 'false'::jsonb, false),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
   AND "permissionsJson" -> 'admin' -> 'owner_management' = 'true'::jsonb;

UPDATE "TenantCustomRole"
   SET "permissionsJson" = jsonb_set("permissionsJson", '{admin,tenant_lifecycle}', 'false'::jsonb, false),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
   AND "permissionsJson" -> 'admin' -> 'tenant_lifecycle' = 'true'::jsonb;
