-- #3720 — an OWNER or AI_ADMIN membership never carries a custom role.
--
-- A custom role REPLACES a membership's permissions at resolution
-- (`resolveTenantContext` reads `customRole.baseRole ?? role`). On an OWNER it
-- was a side door: an ADMIN could assign a READER-based custom role to every
-- OWNER and so demote them in effect, while the enum role still read OWNER and
-- neither the last-OWNER usecase checks nor `tenant_membership_last_owner_guard`
-- fired. #3699 deploy 2 made the same rule for AI_ADMIN. The usecases refuse the
-- combination with a named reason (`BUILT_IN_SCOPE_ROLES` in src/lib/roles.ts);
-- this CHECK is the backstop for any write that does not go through them.
--
-- ─── Why NOT VALID, then a conditional VALIDATE ──────────────────────────────
--
-- Nobody can see production from here, and a row breaking the rule may already
-- exist there (the issue's own query is how it would be found). A plain
-- `ADD CONSTRAINT ... CHECK` scans the table and FAILS on such a row, which
-- would fail `prisma migrate deploy`, and the entrypoint re-runs that on every
-- container start (P3009 — the #2745 outage shape). So:
--
--   1. ADD ... NOT VALID — no scan, and from this statement on every INSERT and
--      every UPDATE is checked. That is the half that closes the door.
--   2. VALIDATE only when no offending row exists. Otherwise RAISE WARNING with
--      the count and leave it NOT VALID: the deploy proceeds, and a person
--      looks at the rows (they are either an exploited #3720 or a deliberate
--      set-up, and the migration cannot tell which).
--
-- Consequence while an offending row exists: NOT VALID still checks updates,
-- so that row cannot be UPDATEd at all — not its status, not anything — until
-- its custom role is cleared. Clearing it (`customRoleId` -> NULL) satisfies the
-- CHECK, so the repair path itself is never blocked. Demoting it to a role that
-- may carry a custom role satisfies it too. DELETE is never checked.
--
-- Post-deploy, confirm with:
--   SELECT conname, convalidated FROM pg_constraint
--    WHERE conname = 'TenantMembership_built_in_scope_role_no_custom_role';
--   SELECT id, "tenantId", role FROM "TenantMembership"
--    WHERE role IN ('OWNER','AI_ADMIN') AND "customRoleId" IS NOT NULL;
-- and, once the second query returns nothing:
--   ALTER TABLE "TenantMembership"
--     VALIDATE CONSTRAINT "TenantMembership_built_in_scope_role_no_custom_role";
--
-- The literal 'AI_ADMIN' is safe here: the value was added and committed by
-- 20261018110000_role_ai_admin, in its own migration and transaction.
--
-- FORWARD-ONLY. Prisma does not model CHECK constraints, so this produces no
-- `migrate diff` residue. A role added to `BUILT_IN_SCOPE_ROLES` needs this
-- CHECK dropped and re-added under the same name, widened, in a new migration.

ALTER TABLE "TenantMembership"
    ADD CONSTRAINT "TenantMembership_built_in_scope_role_no_custom_role"
    CHECK (NOT ("role" IN ('OWNER', 'AI_ADMIN') AND "customRoleId" IS NOT NULL))
    NOT VALID;

DO $$
DECLARE
    offending INTEGER;
BEGIN
    SELECT COUNT(*) INTO offending
    FROM "TenantMembership"
    WHERE "role" IN ('OWNER', 'AI_ADMIN')
      AND "customRoleId" IS NOT NULL;

    IF offending = 0 THEN
        ALTER TABLE "TenantMembership"
            VALIDATE CONSTRAINT "TenantMembership_built_in_scope_role_no_custom_role";
    ELSE
        RAISE WARNING
            '#3720: % TenantMembership row(s) hold OWNER or AI_ADMIN with a custom role. '
            'CHECK "TenantMembership_built_in_scope_role_no_custom_role" is left NOT VALID: '
            'new writes are enforced, these rows cannot be updated until their custom role '
            'is cleared. A person must review them, then VALIDATE the constraint.',
            offending;
    END IF;
END $$;
