-- `admin.integrations_ingest` joins `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS`
-- (`src/lib/roles.ts`, `SIDE_DOOR_ADMIN_KEYS`) beside `agent_harness_ingest`:
-- a custom role granting it may be carried only by an ADMIN membership, for
-- the reason that key is refused (owner decisions, 2026-10-30). An agent-bound
-- API key acting for the membership with `admin:integrations_ingest`,
-- `admin:*` or `*` posts at `/api/t/:slug/admin/agents/integration-scans` past
-- the edge's role gate.
--
-- The key is new, so no stored role states it. A role on a READER, EDITOR or
-- AUDITOR base reads it from its base's default, `false`, and grants nothing.
-- A role on an ADMIN base reads the ADMIN default, which is `true` — so on the
-- deploy that adds the key, an ADMIN-based role carried only by non-ADMIN
-- memberships would gain it. This migration settles those roles once, exactly
-- as `20261030170000_admin_membership_only_keys_off_for_non_admin_custom_roles`
-- settled the first ten keys, and with the same scope:
--
--   - CARRIERS. At least one `TenantMembership` carries the role, and none of
--     its carriers is ADMIN, whatever the membership's status. A role with any
--     ADMIN carrier is left alone, as is a role nobody carries.
--   - WHAT CHANGES. The `admin` domain gets `integrations_ingest` as the JSON
--     boolean `false` — stated, never removed: a removed key would read its
--     base role's default. Every other key of the blob is what it was.
--     `updatedAt` is stamped. The base is never changed.
--   - WHICH ROWS. On a READER, EDITOR or AUDITOR base, a row stating the key
--     as `true` (none can today; the clause is there so a hand-written row is
--     judged as a request would judge it). On an ADMIN base, a row that does
--     not state it `false`. A blob that is not a JSON object becomes
--     `{"admin": {"integrations_ingest": false}}`, which reads the same
--     defaults for everything else.
--   - LEGACY OWNER- AND AI_ADMIN-BASED ROWS ARE LEFT ALONE, for the reason the
--     earlier migration gives: the NOT VALID CHECK
--     "TenantCustomRole_base_role_not_built_in_scope" refuses their update.
--
-- A pure data UPDATE: no DDL. Idempotent: a changed row states the key
-- `false`, so it no longer matches. Safe against a rolling deploy: an old
-- container ignores a key it does not know (`parsePermissionsJson` merges the
-- schema's keys only).
--
-- No audit row is written; the hash-chained trail is appended only through the
-- application's `logEvent`.
--
-- FORWARD-ONLY. To give a role the key back, its non-Admin carriers are moved to
-- Admin or to another custom role on the Members page, then the key is ticked
-- on the Roles page, which writes CUSTOM_ROLE_UPDATED.

UPDATE "TenantCustomRole" AS r
   SET "permissionsJson" =
           (CASE WHEN jsonb_typeof(r."permissionsJson") = 'object' THEN r."permissionsJson" ELSE '{}'::jsonb END)
           || jsonb_build_object(
                  'admin',
                  (CASE WHEN jsonb_typeof(r."permissionsJson" -> 'admin') = 'object'
                        THEN r."permissionsJson" -> 'admin' ELSE '{}'::jsonb END)
                  || '{"integrations_ingest": false}'::jsonb
              ),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE (
           (r."baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
            AND jsonb_typeof(r."permissionsJson" -> 'admin') = 'object'
            AND r."permissionsJson" -> 'admin' -> 'integrations_ingest' = 'true'::jsonb)
        OR (r."baseRole" = 'ADMIN'
            AND NOT COALESCE(
                r."permissionsJson" -> 'admin' @> '{"integrations_ingest": false}'::jsonb,
                false))
       )
   AND EXISTS (
           SELECT 1 FROM "TenantMembership" m
            WHERE m."tenantId" = r."tenantId" AND m."customRoleId" = r."id")
   AND NOT EXISTS (
           SELECT 1 FROM "TenantMembership" m
            WHERE m."tenantId" = r."tenantId" AND m."customRoleId" = r."id" AND m."role" = 'ADMIN');
