-- Owner decisions, 2026-10-30: a custom role granting one of ten admin keys
-- may be carried only by an ADMIN membership.
--
-- The ten are `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` in `src/lib/roles.ts`: six
-- consumed only behind the admin API (`sso`, `agent_tool_exposure`,
-- `agent_policy_card`, `agent_ownership`, `agent_skill_review`,
-- `agent_skill_author`), and four refused by decision because an EDITOR,
-- READER or AUDITOR membership reached them around the edge's role gate — an
-- agent-bound API key acting for it, a run it starts, a key at /api/mcp
-- (`scim`, `compliance_dsar_manage`, `agent_harness_ingest`,
-- `agent_external_tools`). Every writer now refuses a NEW such carriage
-- (CUSTOM_ROLE_ADMIN_KEYS_NEED_ADMIN_MEMBERSHIP). This migration settles the
-- roles already stored, once: where only non-ADMIN memberships carry a role, it
-- switches the ten keys off.
--
-- SCOPE, row by row — the shape of #4520's and #4536's migrations:
--   - CARRIERS. At least one `TenantMembership` carries the role, and none of
--     its carriers is ADMIN, whatever the membership's status. A role with any
--     ADMIN carrier is left alone, as is a role nobody carries (a role with no
--     carriers reaches nobody; the writers judge its next carrier).
--   - WHAT CHANGES. The `admin` domain gets all ten keys as the JSON boolean
--     `false` — stated, never removed: a removed key would read its base
--     role's default, which is `true` on an ADMIN base, or derive from another
--     key (`agent_skill_author` from `agent_skill_review`). Every other key of
--     the blob, the `admin` domain's other keys included, is what it was.
--     `updatedAt` is stamped. The base is never changed.
--   - WHICH ROWS. Only a row that, read as a request reads it
--     (`parsePermissionsJson`), still grants one of the ten:
--       * on a READER, EDITOR or AUDITOR base, a row stating one of them as
--         `true`. Those bases default every one to `false`, so a missing or
--         non-boolean value grants nothing and the row is left alone;
--       * on an ADMIN base, a row that does not state all ten as `false`. That
--         base defaults nine of them to `true`, so a missing `admin` domain, a
--         missing key or a non-boolean value grants; such a row's `admin`
--         domain is created or completed. A blob that is not a JSON object
--         reads the ADMIN defaults whole, and becomes `{"admin": {…ten false}}`,
--         which reads the same defaults for everything else.
--   - LEGACY OWNER- AND AI_ADMIN-BASED ROWS ARE LEFT ALONE. The base filter is
--     an allowlist, for #4520's reason: where the CHECK
--     "TenantCustomRole_base_role_not_built_in_scope" was left NOT VALID over
--     such a row, the row refuses any UPDATE keeping its base, and one refused
--     row would fail the deploy. Changing the base is not this migration's.
--   - Inactive (soft-deleted) rows are judged the same way; deleting a role
--     clears its carriers, so in practice none matches.
--
-- A pure data UPDATE: no DDL. Idempotent: a changed row states all ten as
-- `false`, so it no longer matches. Safe against a rolling deploy: an old
-- container reads the updated blob as a valid permission set with the ten keys
-- off.
--
-- No audit row is written; the hash-chained trail is appended only through the
-- application's `logEvent`.
--
-- FORWARD-ONLY. To give a role a key back, its non-Admin carriers are moved to
-- Admin or to another custom role on the Members page, then the key is ticked
-- on the Roles page, which writes CUSTOM_ROLE_UPDATED.

UPDATE "TenantCustomRole" AS r
   SET "permissionsJson" =
           (CASE WHEN jsonb_typeof(r."permissionsJson") = 'object' THEN r."permissionsJson" ELSE '{}'::jsonb END)
           || jsonb_build_object(
                  'admin',
                  (CASE WHEN jsonb_typeof(r."permissionsJson" -> 'admin') = 'object'
                        THEN r."permissionsJson" -> 'admin' ELSE '{}'::jsonb END)
                  || '{"sso": false, "agent_tool_exposure": false, "agent_policy_card": false, "agent_ownership": false, "agent_skill_review": false, "agent_skill_author": false, "scim": false, "compliance_dsar_manage": false, "agent_harness_ingest": false, "agent_external_tools": false}'::jsonb
              ),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE (
           (r."baseRole" IN ('READER', 'EDITOR', 'AUDITOR')
            AND jsonb_typeof(r."permissionsJson" -> 'admin') = 'object'
            AND EXISTS (
                SELECT 1
                  FROM jsonb_each(r."permissionsJson" -> 'admin') AS granted(key, value)
                 WHERE granted.key IN ('sso', 'agent_tool_exposure', 'agent_policy_card', 'agent_ownership',
                                       'agent_skill_review', 'agent_skill_author', 'scim', 'compliance_dsar_manage',
                                       'agent_harness_ingest', 'agent_external_tools')
                   AND granted.value = 'true'::jsonb))
        OR (r."baseRole" = 'ADMIN'
            AND NOT COALESCE(
                r."permissionsJson" -> 'admin'
                    @> '{"sso": false, "agent_tool_exposure": false, "agent_policy_card": false, "agent_ownership": false, "agent_skill_review": false, "agent_skill_author": false, "scim": false, "compliance_dsar_manage": false, "agent_harness_ingest": false, "agent_external_tools": false}'::jsonb,
                false))
       )
   AND EXISTS (
           SELECT 1 FROM "TenantMembership" m
            WHERE m."tenantId" = r."tenantId" AND m."customRoleId" = r."id")
   AND NOT EXISTS (
           SELECT 1 FROM "TenantMembership" m
            WHERE m."tenantId" = r."tenantId" AND m."customRoleId" = r."id" AND m."role" = 'ADMIN');
