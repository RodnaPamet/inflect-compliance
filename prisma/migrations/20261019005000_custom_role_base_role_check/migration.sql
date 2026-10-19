-- #3734 — a custom role is never built on OWNER or AI_ADMIN.
--
-- A membership that carries a custom role resolves to the role's BASE
-- (`resolveTenantContext` reads `customRole.baseRole ?? role`). So a custom role
-- whose `baseRole` is OWNER makes every membership carrying it resolve as OWNER,
-- whatever its own enum role says, and one on AI_ADMIN does the same for that
-- role. `VALID_BASE_ROLES` in src/app-layer/usecases/custom-roles.ts refuses both
-- at create and update; this CHECK is the backstop for any write that does not go
-- through them. It is the base-role twin of
-- 20261018180000_built_in_scope_role_no_custom_role (#3720), which keeps a custom
-- role off an OWNER or AI_ADMIN membership.
--
-- ─── Why NOT VALID, then a conditional VALIDATE ──────────────────────────────
--
-- The same reasoning as #3720's CHECK: nobody can see production from here, and
-- a plain `ADD CONSTRAINT ... CHECK` scans the table and FAILS `migrate deploy` on
-- an offending row. The entrypoint re-runs that on every container start (P3009,
-- the #2745 outage shape). So:
--
--   1. ADD ... NOT VALID — no scan, and from this statement on every INSERT and
--      every UPDATE is checked.
--   2. VALIDATE only when no offending row exists. Otherwise RAISE WARNING with
--      the count and leave it NOT VALID for a person to look at.
--
-- Consequence while an offending row exists: NOT VALID still checks updates, so
-- that row refuses every UPDATE that leaves its base out of range. Two ways
-- through stay open:
--   - editing the role in the product and choosing a valid base
--     (`updateCustomRole` writes `baseRole` with the rest);
--   - deleting it in the product: `deleteCustomRole` is a soft delete (an
--     UPDATE), and it moves an out-of-range base to READER in the same write,
--     so the deactivation satisfies the CHECK. It also clears the role from
--     every membership.
-- DELETE is never checked.
--
-- Post-deploy, confirm with:
--   SELECT conname, convalidated FROM pg_constraint
--    WHERE conname = 'TenantCustomRole_base_role_not_built_in_scope';
--   SELECT id, "tenantId", "baseRole", "isActive" FROM "TenantCustomRole"
--    WHERE "baseRole" IN ('OWNER','AI_ADMIN');
-- and, once the second query returns nothing:
--   ALTER TABLE "TenantCustomRole"
--     VALIDATE CONSTRAINT "TenantCustomRole_base_role_not_built_in_scope";
--
-- The literal 'AI_ADMIN' is safe here: 20261018110000_role_ai_admin added and
-- committed the value in its own migration and transaction.
--
-- FORWARD-ONLY. Prisma does not model CHECK constraints, so this produces no
-- `migrate diff` residue. A role added to `BUILT_IN_SCOPE_ROLES` needs this CHECK
-- dropped and re-added under the same name, widened, in a new migration, as
-- #3720's does.

ALTER TABLE "TenantCustomRole"
    ADD CONSTRAINT "TenantCustomRole_base_role_not_built_in_scope"
    CHECK ("baseRole" NOT IN ('OWNER', 'AI_ADMIN'))
    NOT VALID;

DO $$
DECLARE
    offending INTEGER;
BEGIN
    SELECT COUNT(*) INTO offending
    FROM "TenantCustomRole"
    WHERE "baseRole" IN ('OWNER', 'AI_ADMIN');

    IF offending = 0 THEN
        ALTER TABLE "TenantCustomRole"
            VALIDATE CONSTRAINT "TenantCustomRole_base_role_not_built_in_scope";
    ELSE
        RAISE WARNING
            '#3734: % TenantCustomRole row(s) are built on OWNER or AI_ADMIN. '
            'CHECK "TenantCustomRole_base_role_not_built_in_scope" is left NOT VALID: '
            'new writes are enforced, and these rows refuse any update that keeps the base out of range. '
            'A person must review them, then VALIDATE the constraint.',
            offending;
    END IF;
END $$;
